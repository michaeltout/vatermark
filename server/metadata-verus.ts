import { createRequire } from 'node:module';
import {
  VerusAdapter, VerusError, TESTNET_SYSTEM_ID, check, same, rawId, compact, compactId,
  requestId, signatureWrapper, exactParse, type SignedRequest, type ChainIdentity,
} from './verus.js';

const require = createRequire(import.meta.url);
const P = require('verus-typescript-primitives') as typeof import('verus-typescript-primitives');
const { VerusIdInterface } = require('verusid-ts-client') as typeof import('verusid-ts-client');
type Descriptor = InstanceType<typeof P.DataDescriptor>;
export interface MetadataDescriptor extends Record<string, unknown> { version: number; flags: number; objectdata: string; epk: string }
export interface MetadataRecord { descriptor: MetadataDescriptor; txid: string; height: number }
export interface MetadataRequestInput {
  identityId: string; locator: string; plaintext: string; zAddress: string;
  requestIdHex: string; callbackUrl: string; responseMode?: 'redirect' | 'post';
}
export interface MetadataResponseInput { body: Buffer; requestHex: string; requestIdHex: string; identityId: string }
const MAX_DESCRIPTOR_BYTES = 8192;
const MAX_METADATA_PAYLOAD_BYTES = 2048;
const MAX_RECORDS = 32;
const MAX_HISTORY = 1024;
const TXID = /^[0-9a-f]{64}$/;
function chainCheck(ok: unknown, message: string): asserts ok {
  if (!ok) throw new VerusError('CHAIN_UNAVAILABLE', message);
}
function checkLookupAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new VerusError('CHAIN_UNAVAILABLE', 'The identity metadata lookup timed out.');
}
function boundedHex(hex: unknown, maxBytes = MAX_DESCRIPTOR_BYTES): Buffer {
  check(typeof hex === 'string' && hex.length > 0 && hex.length <= maxBytes * 2 && /^(?:[0-9a-f]{2})+$/.test(hex), 'Invalid metadata encoding.');
  return Buffer.from(hex, 'hex');
}
function privateDescriptor(descriptor: Descriptor): MetadataDescriptor {
  check(descriptor.version.eqn(1) && descriptor.flags.eqn(5) && descriptor.epk?.length === 32 && descriptor.objectdata.length >= 16 && descriptor.objectdata.length <= MAX_DESCRIPTOR_BYTES && !descriptor.ivk?.length && !descriptor.ssk?.length,
    'Metadata must be encrypted without published decryption keys.');
  return { version: 1, flags: 5, objectdata: descriptor.objectdata.toString('hex'), epk: descriptor.epk.toString('hex') };
}
/** Decode the serialized native CDataDescriptor returned by the Rust worker. */
export function descriptorHexToJson(hex: string): MetadataDescriptor {
  return privateDescriptor(exactParse(new P.DataDescriptor(), boundedHex(hex)));
}
export function descriptorJsonToHex(input: Record<string, unknown>): string {
  check(input && typeof input === 'object' && Object.keys(input).sort().join(',') === 'epk,flags,objectdata,version' && input.version === 1 && input.flags === 5, 'Invalid encrypted metadata descriptor.');
  const json = input as unknown as MetadataDescriptor;
  const descriptor = new P.DataDescriptor({ version: new P.BigNumber(json.version), flags: new P.BigNumber(json.flags), objectdata: boundedHex(json.objectdata), epk: boundedHex(json.epk, 32) });
  privateDescriptor(descriptor);
  return descriptor.toBuffer().toString('hex');
}
/** Native signdata `message` stores its raw UTF-8 bytes in the encrypted leaf. */
export function parseMetadataPayload(objectDataHex: string): Buffer {
  const bytes = boundedHex(objectDataHex, MAX_METADATA_PAYLOAD_BYTES);
  check(bytes.equals(Buffer.from(bytes.toString('utf8'), 'utf8')), 'Invalid UTF-8 metadata payload.');
  return bytes;
}
function parseVdxf(bytes: Buffer): InstanceType<typeof P.VdxfUniValue> {
  const data = exactParse(new P.VdxfUniValue(), bytes);
  check(data.version.eqn(1) && data.values.length === 1 && Object.keys(data.values[0]!).length === 1, 'Expected one metadata VDXF object.');
  return data;
}
function descriptorFromContent(value: unknown): MetadataDescriptor {
  let data: InstanceType<typeof P.VdxfUniValue>;
  if (typeof value === 'string') data = parseVdxf(boundedHex(value));
  else {
    check(value != null && typeof value === 'object' && !Array.isArray(value) && JSON.stringify(value).length <= MAX_DESCRIPTOR_BYTES * 3, 'Invalid identity metadata entry.');
    check(Object.keys(value).length === 1 && Object.hasOwn(value, P.DataDescriptorKey.vdxfid), 'Expected encrypted metadata descriptor.');
    data = parseVdxf(P.VdxfUniValue.fromJson(value as any).toBuffer());
  }
  const descriptor = data.values[0]![P.DataDescriptorKey.vdxfid];
  check(descriptor instanceof P.DataDescriptor, 'Expected encrypted metadata descriptor.');
  return privateDescriptor(descriptor);
}
function contentEntries(record: ChainIdentity, key: string): unknown[] {
  const value = (record.identity.contentmultimap as unknown as Record<string, unknown> | undefined)?.[key];
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}
function descriptorKey(value: MetadataDescriptor): string { return `${value.epk}:${value.objectdata}`; }

// The pinned RPC library exposes a typed generic request method but no history
// convenience method. This fixed read-only request adds no caller-chosen method.
class IdentityHistoryRequest extends P.ApiRequest {
  constructor(private readonly identityId: string, private readonly endHeight: number) { super('VRSCTEST', 'getidentityhistory'); }
  getParams() { return [this.identityId, 0, this.endHeight, false]; }
  toJson() { return { chain: this.chain, cmd: this.cmd, identityId: this.identityId, endHeight: this.endHeight }; }
}
interface HistoryReply {
  fullyqualifiedname: string; txid: string;
  history: Array<{ identity: ChainIdentity['identity']; height: number; output: { txid: string; voutnum: number } }>;
}

/** Optional identity-content publishing; never broadcasts transactions or calls wallet RPCs. */
export class MetadataVerusAdapter extends VerusAdapter {
  constructor(options: ConstructorParameters<typeof VerusAdapter>[0]) {
    super({ ...options, client: options.client ?? new VerusIdInterface('VRSCTEST', options.rpcUrl, { timeout: 15_000, maxContentLength: 2 * 1024 * 1024 }) });
  }

  metadataContentKey(locator: string): { key: string } {
    check(/^[0-9a-f]{64}$/.test(locator), 'Invalid image metadata locator.');
    if (!this.serviceId) throw new VerusError('SERVICE_UNAVAILABLE', 'Metadata lookup needs the public service identity namespace.');
    rawId(this.serviceId);
    return { key: P.getDataKey(`vatermark.image.metadata.${locator}`, this.serviceId, TESTNET_SYSTEM_ID).id };
  }

  async createMetadataRequest(input: MetadataRequestInput): Promise<SignedRequest & { contentKey: string; expiryHeight: number }> {
    rawId(input.identityId);
    check(typeof input.plaintext === 'string' && input.plaintext.length > 0 &&
      Buffer.byteLength(input.plaintext, 'utf8') <= MAX_METADATA_PAYLOAD_BYTES &&
      Buffer.from(input.plaintext, 'utf8').toString('utf8') === input.plaintext, 'Invalid metadata plaintext.');
    const responseMode = input.responseMode ?? 'redirect';
    const url = new URL(input.callbackUrl);
    check((responseMode === 'redirect' || responseMode === 'post') && (url.protocol === 'https:' || (responseMode === 'redirect' && url.protocol === 'http:')) && !url.username && !url.password && !url.hash,
      'Invalid metadata callback URL.');
    const contentKey = this.metadataContentKey(input.locator).key;
    const { height, historical } = await this.service();
    const subject = await this.loadIdentity({ identityId: input.identityId, systemId: TESTNET_SYSTEM_ID, testnet: true, signingHeight: height });
    check(subject.currentActive && !subject.identity.revoked, 'The image signing identity is inactive.');
    const name = subject.historical.identity.name;
    const parent = subject.historical.identity.parent;
    check(typeof name === 'string' && typeof parent === 'string', 'Invalid image signing identity name.');
    // Explicit trailing dot prevents either Mobile or the SDK from adding an
    // implicit mainnet namespace. The name must resolve to this service ID.
    const fqnName = (historical as ChainIdentity & { fullyqualifiedname?: string }).fullyqualifiedname;
    chainCheck(typeof fqnName === 'string' && fqnName.length <= 256, 'The service identity has no qualified namespace.');
    const namespace = `${fqnName.replace(/@$/, '').replace(/\.$/, '')}.`;
    check(P.toIAddress(namespace, 'VRSCTEST') === this.serviceId, 'The service namespace does not match its identity.');
    const fqn = `${namespace}::vatermark.image.metadata.${input.locator}`;
    check(P.getDataKey(fqn, this.serviceId, TESTNET_SYSTEM_ID).id === contentKey, 'Metadata namespace mismatch.');
    const id = requestId(input.requestIdHex);
    const expiryHeight = Math.min(height + 60, 0xffff_ffff);
    const details = P.IdentityUpdateRequestDetails.fromCLIJson({
      name, parent,
      contentmultimap: { [fqn]: { data: {
        message: input.plaintext, encrypttoaddress: input.zAddress, createmmr: true, hashtype: 'sha256',
      } } },
    }, { requestid: id.toJson(), systemid: TESTNET_SYSTEM_ID, expiryheight: String(expiryHeight) });
    check(details.getIdentityAddress(true) === input.identityId && details.containsSignData() && details.signDataMap?.size === 1 && details.identity?.contains.toNumber() === 3,
      'Metadata request must only append identity content.');
    // No address means signdata does encryption/storage only. The wallet signs
    // the identity update transaction and its GenericResponse after consent.
    const request = new P.GenericRequest({
      version: P.GenericRequest.VERSION_CURRENT, flags: P.GenericRequest.FLAG_IS_TESTNET,
      requestID: id, createdAt: new P.BigNumber(Math.floor(Date.now() / 1000)),
      preferredHandler: P.VERUS_MOBILE_GENERIC_REQUEST_HANDLER_ID,
      responseURIs: [P.ResponseURI.fromUriString(input.callbackUrl, responseMode === 'redirect' ? P.ResponseURI.TYPE_REDIRECT : P.ResponseURI.TYPE_POST)],
      signature: new P.VerifiableSignatureData({ version: P.VerifiableSignatureData.TYPE_VERUSID_DEFAULT, isTestnet: true,
        systemID: compact(TESTNET_SYSTEM_ID), identityID: compact(this.serviceId!) }),
      details: [new P.IdentityUpdateRequestOrdinalVDXFObject({ data: details })],
    });
    let signed: InstanceType<typeof P.GenericRequest>;
    try { signed = await this.client.signGenericRequest(request, this.serviceWif!, historical, height); }
    catch { throw new VerusError('SERVICE_UNAVAILABLE', 'The service signing key is invalid or unauthorized.'); }
    signatureWrapper(signed.signature);
    const block = await this.chain(() => this.client.interface.getBlock(String(height)));
    const time = (block as { time?: number }).time;
    chainCheck(Number.isSafeInteger(time), 'The chain service returned an invalid block time.');
    if (!await this.client.verifyGenericRequest(signed, historical, TESTNET_SYSTEM_ID, time)) throw new VerusError('SERVICE_UNAVAILABLE', 'The metadata request signature could not be verified.');
    return { requestHex: signed.toBuffer().toString('hex'), requestHashHex: signed.getRawDataSha256().toString('hex'), walletUri: signed.toWalletDeeplinkUri(), contentKey, expiryHeight };
  }

  async verifyMetadataResponse(input: MetadataResponseInput): Promise<{ txid: string; identityId: string }> {
    try {
      rawId(input.identityId);
      const id = requestId(input.requestIdHex).toIAddress();
      const request = exactParse(new P.GenericRequest(), boundedHex(input.requestHex, 65_536));
      check(request.version.eqn(1) && request.flags.toNumber() === 663 && compactId(request.requestID) === id && request.details.length === 1, 'Invalid metadata request.');
      signatureWrapper(request.signature);
      const requested = request.details[0];
      check(requested instanceof P.IdentityUpdateRequestOrdinalVDXFObject && requested.version.eqn(1) && compactId(requested.data.requestID) === id && requested.data.getIdentityAddress(true) === input.identityId && requested.data.systemID?.toAddress() === TESTNET_SYSTEM_ID && requested.data.flags?.eqn(15),
        'Metadata request belongs to a different identity.');
      const response = exactParse(new P.GenericResponse(), input.body);
      check(response.version.eqn(1) && [151, 407].includes(response.flags.toNumber()) && response.isTestnet(), 'Unsupported metadata response.');
      check(response.createdAt && response.createdAt.gtn(0) && response.createdAt.lte(new P.BigNumber(Math.floor(Date.now() / 1000) + 300)), 'Invalid response timestamp.');
      check(response.handledBy == null || response.handledBy === P.VERUS_MOBILE_GENERIC_REQUEST_HANDLER_ID, 'Unsupported wallet handler.');
      check(compactId(response.requestID) === id && response.requestHashType?.eqn(5) && same(response.requestHash, request.getRawDataSha256()), 'Metadata response belongs to a different request.');
      const outer = signatureWrapper(response.signature, true);
      check(outer.identityId === input.identityId, 'Metadata response must be signed by the image identity.');
      check(requested.data.expiryHeight && requested.data.expiryHeight.gten(outer.height), 'The identity update request expired before the wallet response.');
      check(response.details.length === 1, 'Expected one identity update response.');
      const ordinal = response.details[0];
      check(ordinal instanceof P.IdentityUpdateResponseOrdinalVDXFObject && ordinal.version.eqn(1) && ordinal.data.flags?.eqn(3) && compactId(ordinal.data.requestID) === id && ordinal.data.txid?.length === 32,
        'Invalid identity update response.');
      const txid = ordinal.data.getTxidString();
      check(TXID.test(txid) && txid !== '0'.repeat(64), 'Invalid metadata transaction ID.');
      const state = await this.loadIdentity({ identityId: input.identityId, systemId: TESTNET_SYSTEM_ID, testnet: true, signingHeight: outer.height });
      check(state.currentActive && !state.identity.revoked, 'The metadata response signing identity is inactive.');
      const block = await this.chain(() => this.client.interface.getBlock(String(outer.height)));
      const time = (block as { time?: number }).time;
      chainCheck(Number.isSafeInteger(time), 'The chain service returned an invalid block time.');
      check(await this.client.verifyGenericResponse(response, state.historical, TESTNET_SYSTEM_ID, time), 'Invalid metadata response signature.');
      // This receipt proves wallet acknowledgement only. Publication is verified
      // separately through confirmed identity content and decrypted metadata.
      return { txid, identityId: input.identityId };
    } catch (error) {
      if (error instanceof VerusError) throw error;
      throw new VerusError('INVALID_SIGNATURE', 'Malformed or invalid metadata wallet response.');
    }
  }

  async getMetadataRecords(input: { identityId: string; contentKey: string; signal?: AbortSignal }): Promise<{ records: MetadataRecord[]; height: number }> {
    checkLookupAbort(input.signal);
    rawId(input.identityId); rawId(input.contentKey);
    const height = await this.tip();
    checkLookupAbort(input.signal);
    const aggregate = await this.chain(() => this.client.interface.getIdentityContent(input.identityId, 0, height, false, height, input.contentKey));
    checkLookupAbort(input.signal);
    this.validateRecord(aggregate, input.identityId, height);
    const entries = contentEntries(aggregate, input.contentKey);
    chainCheck(entries.length <= MAX_RECORDS, 'Too many image metadata entries.');
    const wanted = new Map<string, MetadataDescriptor>();
    try { for (const entry of entries) { const descriptor = descriptorFromContent(entry); wanted.set(descriptorKey(descriptor), descriptor); } }
    catch { throw new VerusError('CHAIN_UNAVAILABLE', 'The identity contains unsupported or malformed encrypted metadata.'); }
    if (!wanted.size) return { records: [], height };
    // getidentitycontent aggregates bytes but omits each entry's source txid.
    // signdata links use a zero txid to refer to their own transaction, so pair
    // only current, undeleted entries with their corresponding identity history.
    const history = await this.chain(() => this.client.interface.request<HistoryReply>(new IdentityHistoryRequest(input.identityId, height)));
    checkLookupAbort(input.signal);
    chainCheck(Array.isArray(history.history) && history.history.length <= MAX_HISTORY, 'Identity metadata history exceeds the supported limit.');
    const records: MetadataRecord[] = [];
    for (const event of history.history) {
      chainCheck(event.identity?.identityaddress === input.identityId && event.identity.systemid === TESTNET_SYSTEM_ID && Number.isSafeInteger(event.height) && event.height >= 1 && event.height <= height && TXID.test(event.output?.txid ?? ''), 'Mismatched identity metadata history.');
      for (const entry of contentEntries({ identity: event.identity } as ChainIdentity, input.contentKey)) {
        try {
          const descriptor = descriptorFromContent(entry);
          if (wanted.has(descriptorKey(descriptor))) records.push({ descriptor, txid: event.output.txid, height: event.height });
        } catch { /* Unrelated obsolete history is not an active metadata record. */ }
      }
    }
    chainCheck(records.length > 0 && records.length <= MAX_RECORDS, 'The metadata source transaction could not be established.');
    return { records: records.sort((a, b) => b.height - a.height), height };
  }

  async getReferencedMetadata(input: { objectDataHex: string; sourceTxid: string; signal?: AbortSignal }): Promise<MetadataDescriptor> {
    checkLookupAbort(input.signal);
    check(TXID.test(input.sourceTxid), 'Invalid metadata source transaction.');
    const object = parseVdxf(boundedHex(input.objectDataHex));
    const link = object.values[0]![P.CrossChainDataRefKey.vdxfid];
    check(link instanceof P.CrossChainDataRef && link.ref instanceof P.PBaaSEvidenceRef, 'Only on-chain metadata evidence references are supported.');
    const ref = link.ref;
    check(ref.version.eqn(1) && ref.flags.toNumber() === 1 && !ref.systemId && !ref.dataHash.length && ref.objectNum.eqn(0) && ref.subObject.eqn(0), 'Unsupported metadata evidence reference.');
    check(ref.output.hash.equals(Buffer.alloc(32)) || Buffer.from(ref.output.hash).reverse().toString('hex') === input.sourceTxid, 'Metadata reference points outside its identity update.');
    const output = ref.output.n.toNumber();
    check(Number.isSafeInteger(output) && output >= 0 && output < 1000, 'Invalid metadata evidence output.');
    const transaction = await this.chain(() => this.client.interface.getRawTransaction(input.sourceTxid, 1));
    checkLookupAbort(input.signal);
    chainCheck(typeof transaction !== 'string' && transaction.txid === input.sourceTxid && Number.isSafeInteger(transaction.confirmations) && transaction.confirmations! > 0 && Array.isArray(transaction.vout), 'Metadata transaction is not confirmed.');
    const vout: any = transaction.vout[output];
    const evidence = vout?.scriptPubKey?.notaryevidence;
    chainCheck(vout?.n === output && evidence?.version === 1 && evidence.type === 3 && evidence.systemid === TESTNET_SYSTEM_ID && evidence.evidence?.version === 1 && Array.isArray(evidence.evidence.chainobjects) && evidence.evidence.chainobjects.length === 1, 'Unsupported metadata evidence output.');
    const item = evidence.evidence.chainobjects[0];
    chainCheck(item?.vdxftype === P.EvidenceDataKey.vdxfid, 'Unexpected metadata evidence type.');
    try {
      const data = exactParse(new P.EvidenceData(), boundedHex(item.value?.hex, 16_384));
      check(data.version.eqn(1) && data.type.eqn(1) && data.vdxfd === P.DataDescriptorKey.vdxfid, 'Invalid metadata evidence.');
      return descriptorFromContent(data.data_vec.toString('hex'));
    } catch { throw new VerusError('CHAIN_UNAVAILABLE', 'Malformed encrypted metadata evidence.'); }
  }
}
