import { createHash } from 'node:crypto';
import { WorkerError, type Worker } from './worker.js';
import { HttpError } from './errors.js';
import { VerusError } from './verus.js';
import { MetadataVerusAdapter, parseMetadataPayload } from './metadata-verus.js';

export const MAX_METADATA_BYTES = 512;
export interface ImageMetadata { title?: string; description?: string; url?: string }
export interface MetadataContext { profile: number; identityId: string; systemId: string; nativeSignature: string }
export interface MetadataCapability { version: number; zAddress: string; locator: string }
export interface MetadataLookup {
  status: 'decrypted' | 'not_found' | 'unavailable' | 'invalid';
  message?: string; data?: ImageMetadata; txid?: string; height?: number;
}
export interface MetadataJob {
  status: 'preparing' | 'awaiting_approval' | 'submitted' | 'published' | 'expired' | 'failed';
  requestIdHex: string; createdAt: number; expiresAt: number;
  requestHex?: string; walletUri?: string; contentKey?: string;
  locator?: string; payloadHash?: string; acceptedHash?: string;
  txid?: string; message?: string; checkedAt?: number;
}
export type MetadataAdapter = Pick<MetadataVerusAdapter, 'metadataContentKey' | 'createMetadataRequest' | 'verifyMetadataResponse' | 'getMetadataRecords' | 'getReferencedMetadata'>;

export function validateMetadata(input: unknown): ImageMetadata {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'INVALID_METADATA', 'Enter a title, description, or link.');
  const source = input as Record<string, unknown>;
  const limits = { title: 120, description: 400, url: 300 } as const;
  const result: ImageMetadata = {};
  for (const [key, value] of Object.entries(source)) {
    if (!Object.hasOwn(limits, key) || typeof value !== 'string') throw new HttpError(400, 'INVALID_METADATA', 'Image details support only a text title, description, and link.');
    const field = key as keyof ImageMetadata;
    const text = value.trim();
    if (text.length > limits[field] || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new HttpError(400, 'INVALID_METADATA', 'Image details contain unsupported or excessive text.');
    if (text) result[field] = text;
  }
  if (!Object.keys(result).length) throw new HttpError(400, 'INVALID_METADATA', 'Enter a title, description, or link.');
  if (result.url) {
    try {
      if (/[\u0000-\u0020\u007f]/.test(result.url)) throw new Error();
      const url = new URL(result.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch { throw new HttpError(400, 'INVALID_METADATA', 'The link must be an HTTP or HTTPS URL without embedded credentials.'); }
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_METADATA_BYTES) throw new HttpError(400, 'METADATA_TOO_LARGE', `Image details must fit within ${MAX_METADATA_BYTES} UTF-8 bytes.`);
  return result;
}

export function metadataView(metadata: MetadataJob | undefined) {
  if (!metadata) return undefined;
  return { status: metadata.status, expiresAt: new Date(metadata.expiresAt).toISOString(),
    walletUri: metadata.status === 'awaiting_approval' ? metadata.walletUri : undefined,
    qrText: metadata.status === 'awaiting_approval' ? metadata.walletUri : undefined,
    message: metadata.message, txid: metadata.txid };
}

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const unavailable = (): MetadataLookup => ({ status: 'unavailable', message: 'The image signature is valid, but its identity metadata could not be checked.' });
class MetadataLookupDeadline extends Error {}

/** Only server-verified image signatures reach this service. Never send them to RPC. */
export class MetadataService {
  constructor(private worker: Worker, readonly adapter: MetadataAdapter, private lookupTimeoutMs = 12_000) {
    if (!Number.isFinite(lookupTimeoutMs) || lookupTimeoutMs <= 0) throw new RangeError('Metadata lookup deadline must be positive.');
  }

  async prepare(context: MetadataContext, metadata: ImageMetadata, input: {
    requestIdHex: string; callbackUrl: string; responseMode: 'redirect' | 'post';
  }) {
    metadata = validateMetadata(metadata);
    const capability = await this.worker.run<MetadataCapability>({ cmd: 'metadata_derive', context });
    const plaintext = JSON.stringify({ schema: 'vatermark-image-metadata', version: 1, locator: capability.locator, data: metadata });
    const signed = await this.adapter.createMetadataRequest({ ...input, identityId: context.identityId,
      locator: capability.locator, plaintext, zAddress: capability.zAddress });
    // The request contains plaintext; the wallet encrypts it to this recipient.
    // Bind confirmation to the approved bytes because wallet ciphertext is randomized.
    // The image signature, viewing key and SSK never enter the request.
    return { ...signed, locator: capability.locator, payloadHash: digest(Buffer.from(plaintext, 'utf8')) };
  }

  private async decrypt(context: MetadataContext, descriptor: Record<string, unknown>): Promise<string> {
    const { plaintextHex } = await this.worker.run<{ plaintextHex: string }>({ cmd: 'metadata_decrypt', context, descriptor });
    if (!/^(?:[0-9a-f]{2})+$/.test(plaintextHex) || plaintextHex.length > 32_768) throw new Error('Invalid decrypted metadata size');
    return plaintextHex;
  }

  async lookup(context: MetadataContext, expected?: { contentKey: string; payloadHash: string; txid?: string }): Promise<MetadataLookup> {
    const controller = new AbortController();
    const deadline = performance.now() + this.lookupTimeoutMs;
    const ensureTime = () => {
      if (controller.signal.aborted || performance.now() >= deadline) {
        controller.abort();
        throw new MetadataLookupDeadline();
      }
    };
    const step = async <T>(operation: () => T | Promise<T>): Promise<T> => {
      ensureTime();
      const result = await operation();
      ensureTime();
      return result;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<MetadataLookup>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(unavailable()); }, this.lookupTimeoutMs);
    });
    // An in-flight SDK call may finish after the deadline. Abort checks inside
    // adapter read methods and between every stage stop follow-up requests.
    const read = async (): Promise<MetadataLookup> => {
      try {
        const capability = await step(() => this.worker.run<MetadataCapability>({ cmd: 'metadata_derive', context }));
        const { key } = await step(() => this.adapter.metadataContentKey(capability.locator));
        if (expected && expected.contentKey !== key) return { status: 'invalid', message: 'The metadata request does not match this image.' };
        const contents = await step(() => this.adapter.getMetadataRecords({ identityId: context.identityId, contentKey: key, signal: controller.signal }));
        if (!contents.records.length) return { status: 'not_found', message: 'No published image details were found for this signature.' };
        // Newest record wins. Do not hide a broken replacement by displaying an older value.
        const record = contents.records[0];
        if (expected?.txid && expected.txid !== record.txid) return { status: 'not_found', message: 'The approved identity update has not appeared in confirmed chain data yet.' };
        const linkData = await step(() => this.decrypt(context, record.descriptor));
        const external = await step(() => this.adapter.getReferencedMetadata({ objectDataHex: linkData, sourceTxid: record.txid, signal: controller.signal }));
        const wrappedPayload = await step(() => this.decrypt(context, external));
        const plaintext = parseMetadataPayload(wrappedPayload);
        if (expected && digest(plaintext) !== expected.payloadHash) return { status: 'invalid', message: 'The published details differ from the approved request.' };
        const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
        if (!decoded || decoded.schema !== 'vatermark-image-metadata' || decoded.version !== 1 || decoded.locator !== capability.locator
          || Object.keys(decoded).some(key => !['schema', 'version', 'locator', 'data'].includes(key))) throw new Error('Mismatched metadata record');
        const data = validateMetadata(decoded.data);
        ensureTime();
        return { status: 'decrypted', data, txid: record.txid, height: record.height };
      } catch (error) {
        if (error instanceof MetadataLookupDeadline || controller.signal.aborted) return unavailable();
        if (error instanceof VerusError && ['CHAIN_UNAVAILABLE', 'SERVICE_UNAVAILABLE'].includes(error.code)) return unavailable();
        if (error instanceof WorkerError && ['unavailable', 'timeout', 'io_error', 'invalid_response'].includes(error.code)) return unavailable();
        if (error instanceof HttpError && ['BUSY', 'RATE_LIMITED'].includes(error.code)) return unavailable();
        // Parsing, AEAD or schema errors must never erase a valid image signature.
        return { status: 'invalid', message: 'The published image details could not be decrypted and validated with this image.' };
      }
    };
    try { return await Promise.race([read(), timeout]); }
    finally { clearTimeout(timer); }
  }
}
