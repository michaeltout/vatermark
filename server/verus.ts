import { createHash, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';

// The pinned official SDKs ship CommonJS. Keep their single shared primitives
// instance: their serializers and validators depend on instanceof checks.
const require = createRequire(import.meta.url);
const { VerusIdInterface } = require('verusid-ts-client') as typeof import('verusid-ts-client');
const P = require('verus-typescript-primitives') as typeof import('verus-typescript-primitives');
export type Client = InstanceType<typeof VerusIdInterface>;
type Request = InstanceType<typeof P.GenericRequest>;
type CompactId = InstanceType<typeof P.CompactIAddressObject>;
type Signature = InstanceType<typeof P.VerifiableSignatureData>;
export type ChainIdentity = NonNullable<Awaited<ReturnType<Client['interface']['getIdentity']>>['result']>;

export const TESTNET_SYSTEM_ID = P.TESTNET_VERUS_CHAINID;
export const GENERIC_RESPONSE_QUERY_KEY = P.GENERIC_RESPONSE_DEEPLINK_VDXF_KEY.vdxfid;
const ID_ADDRESS_VERSION = 102;
export type VerusErrorCode = 'INVALID_SIGNATURE' | 'UNSUPPORTED_NETWORK' | 'CHAIN_UNAVAILABLE' | 'SERVICE_UNAVAILABLE';
export class VerusError extends Error {
  constructor(public readonly code: VerusErrorCode, message: string) { super(message); this.name = 'VerusError'; }
}
export interface RustIdentity {
  id: number[]; system_id: number[]; testnet: boolean; height: number;
  min_sigs: number; revoked: boolean; primary_addresses: string[];
}
export interface DisplayIdentity {
  id: string; name: string; systemId: string; signingHeight: number; currentStatus: string;
}
export interface IdentityQuery { identityId: string; systemId: string; testnet: boolean; signingHeight: number }
export interface ResolvedIdentity {
  identity: RustIdentity; currentActive: boolean; displayIdentity: DisplayIdentity;
}
export interface RequestInput { message: string; callbackUrl: string; requestIdHex: string; responseMode?: 'redirect' | 'post' }
export interface SignedRequest { requestHex: string; requestHashHex: string; walletUri: string }
export interface ResponseInput { body: Buffer; requestHex: string; message: string; requestIdHex: string }
export interface VerifiedResponse {
  identityId: string; systemId: string; nativeSignature: string;
  identity: RustIdentity; displayIdentity: DisplayIdentity;
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();
export function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new VerusError('INVALID_SIGNATURE', message);
}
export function same(a: Buffer | undefined, b: Buffer): boolean {
  return Buffer.isBuffer(a) && a.length === b.length && timingSafeEqual(a, b);
}
export function rawId(address: string, version = ID_ADDRESS_VERSION): Buffer {
  const decoded = P.fromBase58Check(address);
  check(decoded.version === version && decoded.hash.length === 20, 'Unsupported address encoding.');
  return decoded.hash;
}
export function compact(address: string): CompactId {
  rawId(address);
  return new P.CompactIAddressObject({ type: P.CompactIAddressObject.TYPE_I_ADDRESS, address, rootSystemName: 'VRSCTEST' });
}
export function compactId(value: CompactId | undefined): string {
  check(value && value.version.eqn(1) && value.isIaddress(), 'Expected a typed identity address.');
  rawId(value.address);
  return value.address;
}
export function requestId(hex: string): CompactId {
  check(/^[0-9a-f]{40}$/.test(hex), 'Invalid request identifier.');
  return compact(P.toBase58Check(Buffer.from(hex, 'hex'), ID_ADDRESS_VERSION));
}
function messageProfile(message: string): void {
  check(/^Vatermark image authentication v2\nsha256:[0-9a-f]{64}$/.test(message), 'Unsupported signing message profile.');
}
/** Validate the complete native vector, not only the bytes consumed by the SDK. */
function nativeHeight(bytes: Buffer): number {
  check(Buffer.isBuffer(bytes) && bytes.length === 73 && bytes[0] === 2 && bytes[1] === 5 && bytes[6] === 1 && bytes[7] === 65 && bytes[8]! >= 27 && bytes[8]! <= 34,
    'Requires one native Verus v2/SHA256 compact signature.');
  return bytes.readUInt32LE(2);
}
export function signatureWrapper(signature: Signature | undefined, mobileOuter = false): { identityId: string; height: number } {
  // Current Mobile omits the outer wrapper version and therefore serializes 0.
  // Its wire layout/digest is identical to wrapper 1. Accept this narrow legacy
  // case only on callbacks, with an explicit system and all native v2/SHA256,
  // authority and request-binding checks below. New requests and inner image
  // signatures always require wrapper 1; no native signature downgrade exists.
  const supported = signature && (signature.version.eqn(1) || (mobileOuter && signature.version.eqn(0) && signature.flags.eqn(16)));
  check(supported && signature.signatureVersion.eqn(2) && signature.hashType.eqn(5), 'Unsupported signature wrapper.');
  check([0, 16].includes(signature.flags.toNumber()), 'Unsupported signature context.');
  check(!signature.vdxfKeys?.length && !signature.vdxfKeyNames?.length && !signature.boundHashes?.length && !signature.statements?.length, 'Unexpected signature context.');
  if (compactId(signature.systemID) !== TESTNET_SYSTEM_ID) throw new VerusError('UNSUPPORTED_NETWORK', 'Only VRSCTEST signatures are supported.');
  return { identityId: compactId(signature.identityID), height: nativeHeight(signature.signatureAsVch) };
}
export function exactParse<T extends { fromBuffer(b: Buffer, o: number): number; toBuffer(): Buffer }>(value: T, bytes: Buffer): T {
  check(bytes.length > 0 && bytes.length <= 65_536, 'Invalid callback size.');
  check(value.fromBuffer(bytes, 0) === bytes.length, 'Trailing or truncated callback data.');
  check(value.toBuffer().equals(bytes), 'Noncanonical callback encoding.');
  return value;
}
function parseRequest(hex: string, expectedMessage: string, expectedId: string): Request {
  check(/^(?:[0-9a-f]{2})+$/.test(hex), 'Invalid stored request.');
  const req = exactParse(new P.GenericRequest(), Buffer.from(hex, 'hex'));
  check(req.version.eqn(1) && req.flags.toNumber() === (1 | 2 | 4 | 16 | 128 | 512), 'Unsupported request envelope.');
  signatureWrapper(req.signature);
  check(compactId(req.requestID) === expectedId && req.details.length === 1, 'Stored request identifier mismatch.');
  const ordinal = req.details[0];
  check(ordinal instanceof P.DataPacketRequestOrdinalVDXFObject && ordinal.version.eqn(1), 'Unsupported request details.');
  const detail = ordinal.data;
  check(detail.version.eqn(1) && detail.flags.toNumber() === 9 && compactId(detail.requestID) === expectedId && detail.signableObjects.length === 1 && detail.signableObjects[0] === expectedMessage,
    'Stored signing message mismatch.');
  return req;
}

/** Public chain reader and local request signer. No wallet or daemon RPCs. */
export class VerusAdapter {
  protected readonly client: Client;
  protected readonly serviceId?: string;
  protected readonly serviceWif?: string;

  constructor(options: { rpcUrl: string; serviceId?: string; serviceWif?: string; client?: Client }) {
    this.client = options.client ?? new VerusIdInterface('VRSCTEST', options.rpcUrl, { timeout: 15_000 });
    this.serviceId = options.serviceId;
    this.serviceWif = options.serviceWif;
  }

  protected async chain<T>(call: () => Promise<{ result?: T | null; error?: unknown }>): Promise<T> {
    try {
      const reply = await call();
      if (reply.error || reply.result == null) throw new Error('RPC failed');
      return reply.result;
    } catch {
      // Never forward SDK, HTTP, or RPC error objects: they can contain config.
      throw new VerusError('CHAIN_UNAVAILABLE', 'The chain service could not supply the required data.');
    }
  }

  protected async tip(): Promise<number> {
    const info = await this.chain(() => this.client.interface.getInfo());
    if (info.chainid !== TESTNET_SYSTEM_ID || info.name !== 'VRSCTEST' || info.testnet !== true) {
      throw new VerusError('UNSUPPORTED_NETWORK', 'The configured RPC endpoint is not VRSCTEST.');
    }
    const height = info.blocks;
    if (!Number.isSafeInteger(height) || height < 1 || height > 0xffff_ffff) throw new VerusError('CHAIN_UNAVAILABLE', 'The chain service returned an invalid height.');
    return height;
  }

  protected validateRecord(record: ChainIdentity, id: string, height?: number): void {
    const identity = record?.identity;
    if (!identity || identity.identityaddress !== id || identity.systemid !== TESTNET_SYSTEM_ID || !Number.isSafeInteger(record.blockheight) || record.blockheight < 0 || (height !== undefined && record.blockheight > height)) {
      throw new VerusError('CHAIN_UNAVAILABLE', 'The chain service returned mismatched identity state.');
    }
    if (![1, 2, 3].includes(identity.version ?? 0) || typeof identity.flags !== 'number' || !Number.isSafeInteger(identity.flags) || identity.flags < 0 || identity.flags > 0xffff_ffff || typeof record.status !== 'string') {
      throw new VerusError('CHAIN_UNAVAILABLE', 'The chain service returned unsupported identity state.');
    }
  }

  protected async loadIdentity(query: IdentityQuery): Promise<ResolvedIdentity & { historical: ChainIdentity }> {
    if (!query.testnet || query.systemId !== TESTNET_SYSTEM_ID) throw new VerusError('UNSUPPORTED_NETWORK', 'Only VRSCTEST is supported.');
    rawId(query.identityId);
    check(Number.isSafeInteger(query.signingHeight) && query.signingHeight >= 1 && query.signingHeight <= 0xffff_ffff, 'Invalid signing height.');
    const height = await this.tip();
    if (query.signingHeight > height) throw new VerusError('CHAIN_UNAVAILABLE', 'The signing height is not yet available from the chain service.');
    const [historical, current] = await Promise.all([
      this.chain(() => this.client.interface.getIdentity(query.identityId, query.signingHeight)),
      this.chain(() => this.client.interface.getIdentity(query.identityId)),
    ]);
    this.validateRecord(historical, query.identityId, query.signingHeight);
    this.validateRecord(current, query.identityId);
    const authority = historical.identity;
    check(authority.minimumsignatures === 1 && Array.isArray(authority.primaryaddresses) && authority.primaryaddresses.length > 0, 'This compact format requires a one-signature identity.');
    try { authority.primaryaddresses.forEach(a => rawId(a, 60)); } catch { throw new VerusError('INVALID_SIGNATURE', 'Identity uses an unsupported primary address.'); }
    const currentActive = current.status === 'active' && (current.identity.flags! & 0x8000) === 0;
    return {
      historical,
      currentActive,
      identity: {
        id: Array.from(rawId(query.identityId)), system_id: Array.from(rawId(TESTNET_SYSTEM_ID)), testnet: true,
        height: query.signingHeight, min_sigs: authority.minimumsignatures,
        revoked: historical.status !== 'active' || (authority.flags! & 0x8000) !== 0,
        primary_addresses: [...authority.primaryaddresses],
      },
      displayIdentity: {
        id: query.identityId, name: current.identity.name || query.identityId,
        systemId: TESTNET_SYSTEM_ID, signingHeight: query.signingHeight,
        currentStatus: currentActive ? 'active' : 'revoked',
      },
    };
  }

  async resolveIdentity(query: IdentityQuery): Promise<ResolvedIdentity> {
    const { historical: _, ...result } = await this.loadIdentity(query);
    return result;
  }

  protected async service(): Promise<{ height: number; historical: ChainIdentity }> {
    if (!this.serviceId || !this.serviceWif) throw new VerusError('SERVICE_UNAVAILABLE', 'Signing needs a configured service identity and secret WIF.');
    try { rawId(this.serviceId); } catch { throw new VerusError('SERVICE_UNAVAILABLE', 'The configured service identity is invalid.'); }
    const height = await this.tip();
    const state = await this.loadIdentity({ identityId: this.serviceId, systemId: TESTNET_SYSTEM_ID, testnet: true, signingHeight: height });
    if (!state.currentActive || state.identity.revoked) throw new VerusError('SERVICE_UNAVAILABLE', 'The service identity is not active.');
    return { height, historical: state.historical };
  }

  async status(): Promise<{ enabled: boolean; reason?: string }> {
    try {
      const { height, historical } = await this.service();
      const proof = sha256('Vatermark service key authorization check');
      const signature = await this.client.signHash(this.serviceId!, proof, this.serviceWif!, historical, height, TESTNET_SYSTEM_ID);
      if (!await this.client.verifyHash(this.serviceId!, signature, proof, historical, TESTNET_SYSTEM_ID)) throw new Error('Unauthorized key');
      return { enabled: true };
    } catch (error) {
      return { enabled: false, reason: error instanceof VerusError ? error.message : 'The service signing key is invalid or unauthorized.' };
    }
  }

  async createRequest(input: RequestInput): Promise<SignedRequest> {
    messageProfile(input.message);
    const url = new URL(input.callbackUrl);
    const responseMode = input.responseMode ?? 'post';
    check(responseMode === 'redirect' || responseMode === 'post', 'Unsupported wallet response mode.');
    check(url.protocol === 'https:' || (responseMode === 'redirect' && url.protocol === 'http:'),
      responseMode === 'post' ? 'Wallet POST callbacks require HTTPS.' : 'Wallet redirects require HTTP or HTTPS.');
    check(!url.username && !url.password && !url.hash, 'Invalid callback URL.');
    const id = requestId(input.requestIdHex);
    const { height, historical } = await this.service();
    const req = new P.GenericRequest({
      version: P.GenericRequest.VERSION_CURRENT,
      flags: P.GenericRequest.FLAG_IS_TESTNET,
      requestID: id, createdAt: new P.BigNumber(Math.floor(Date.now() / 1000)),
      preferredHandler: P.VERUS_MOBILE_GENERIC_REQUEST_HANDLER_ID,
      // Mobile prefers POST when both are present. Advertise exactly the chosen
      // transport; both carry the same signed GenericResponse bytes.
      responseURIs: [P.ResponseURI.fromUriString(input.callbackUrl,
        responseMode === 'redirect' ? P.ResponseURI.TYPE_REDIRECT : P.ResponseURI.TYPE_POST)],
      signature: new P.VerifiableSignatureData({
        version: P.VerifiableSignatureData.TYPE_VERUSID_DEFAULT, isTestnet: true,
        systemID: compact(TESTNET_SYSTEM_ID), identityID: compact(this.serviceId!),
      }),
      details: [new P.DataPacketRequestOrdinalVDXFObject({ data: new P.DataPacketRequestDetails({
        flags: P.DataPacketRequestDetails.FLAG_FOR_USERS_SIGNATURE, requestID: id, signableObjects: [input.message],
      }) })],
    });
    let signed: Request;
    try { signed = await this.client.signGenericRequest(req, this.serviceWif!, historical, height); }
    catch { throw new VerusError('SERVICE_UNAVAILABLE', 'The service signing key is invalid or unauthorized.'); }
    signatureWrapper(signed.signature);
    const block = await this.chain(() => this.client.interface.getBlock(String(height)));
    const time = (block as { time?: number }).time;
    if (!Number.isSafeInteger(time)) throw new VerusError('CHAIN_UNAVAILABLE', 'The chain service returned an invalid block time.');
    if (!await this.client.verifyGenericRequest(signed, historical, TESTNET_SYSTEM_ID, time)) {
      throw new VerusError('SERVICE_UNAVAILABLE', 'The service identity signature could not be verified.');
    }
    return { requestHex: signed.toBuffer().toString('hex'), requestHashHex: signed.getRawDataSha256().toString('hex'), walletUri: signed.toWalletDeeplinkUri() };
  }

  async verifyResponse(input: ResponseInput): Promise<VerifiedResponse> {
    // Reject malformed bytes without exposing SDK parser errors to the caller.
    try { return await this.verifyParsedResponse(input); }
    catch (error) {
      if (error instanceof VerusError) throw error;
      throw new VerusError('INVALID_SIGNATURE', 'Malformed or invalid wallet response.');
    }
  }

  private async verifyParsedResponse(input: ResponseInput): Promise<VerifiedResponse> {
    messageProfile(input.message);
    const expectedId = requestId(input.requestIdHex).toIAddress();
    const request = parseRequest(input.requestHex, input.message, expectedId);
    const response = exactParse(new P.GenericResponse(), input.body);
    check(response.version.eqn(1), 'Unsupported response version.');
    if (!response.isTestnet()) throw new VerusError('UNSUPPORTED_NETWORK', 'Only VRSCTEST responses are supported.');
    // Signed + request ID + createdAt + testnet + request hash; Mobile also sets handledBy.
    check([151, 407].includes(response.flags.toNumber()), 'Unsupported response flags or encrypted layout.');
    check(response.createdAt && response.createdAt.gtn(0) && response.createdAt.lte(new P.BigNumber(Math.floor(Date.now() / 1000) + 300)), 'Invalid response timestamp.');
    check(response.handledBy == null || response.handledBy === P.VERUS_MOBILE_GENERIC_REQUEST_HANDLER_ID, 'Unsupported wallet handler.');
    check(compactId(response.requestID) === expectedId && response.requestHashType?.eqn(5) && same(response.requestHash, request.getRawDataSha256()), 'Response belongs to a different request.');
    const outer = signatureWrapper(response.signature, true);
    check(response.details.length === 1, 'Expected exactly one data response.');
    const ordinal = response.details[0];
    check(ordinal instanceof P.DataResponseOrdinalVDXFObject && ordinal.version.eqn(1), 'Unexpected response details.');
    const detail = ordinal.data;
    check(detail.flags?.eqn(1) && compactId(detail.requestID) === expectedId, 'Data response request identifier mismatch.');
    const descriptor = detail.data;
    check(descriptor.version.eqn(1) && descriptor.flags.eqn(0), 'Unsupported or encrypted response data.');
    const data = exactParse(new P.VdxfUniValue(), descriptor.objectdata);
    check(data.version.eqn(1) && data.values.length === 1, 'Expected exactly one image signature.');
    const value = data.values[0]!;
    check(Object.keys(value).length === 1, 'Unexpected data entries.');
    const sig = value[P.SignatureDataKey.vdxfid];
    check(sig instanceof P.SignatureData && sig.version.eqn(1) && sig.sigType.eqn(1) && sig.hashType.eqn(5), 'Unsupported inner signature wrapper.');
    check(!sig.vdxfKeys.length && !sig.vdxfKeyNames.length && !sig.boundHashes.length, 'Unexpected inner signature context.');
    if (sig.systemID !== TESTNET_SYSTEM_ID) throw new VerusError('UNSUPPORTED_NETWORK', 'Only VRSCTEST signatures are supported.');
    check(sig.identityID === outer.identityId && same(sig.signatureHash, sha256(input.message)), 'Image signer or signed message mismatch.');
    const height = nativeHeight(sig.signatureAsVch);
    const innerState = await this.loadIdentity({ identityId: sig.identityID, systemId: sig.systemID, testnet: true, signingHeight: height });
    check(!innerState.identity.revoked && innerState.currentActive, 'The signing identity is revoked or inactive.');
    // The outer envelope may legitimately have a different signing height.
    const outerState = height === outer.height ? innerState : await this.loadIdentity({ identityId: outer.identityId, systemId: TESTNET_SYSTEM_ID, testnet: true, signingHeight: outer.height });
    check(!outerState.identity.revoked && outerState.currentActive, 'The response signing identity is revoked or inactive.');
    const block = await this.chain(() => this.client.interface.getBlock(String(outer.height)));
    const time = (block as { time?: number }).time;
    if (!Number.isSafeInteger(time)) throw new VerusError('CHAIN_UNAVAILABLE', 'The chain service returned an invalid block time.');
    check(await this.client.verifyGenericResponse(response, outerState.historical, TESTNET_SYSTEM_ID, time), 'Invalid wallet response signature.');
    const nativeSignature = sig.signatureAsVch.toString('base64');
    const info = await this.client.getSignatureInfo(sig.identityID, nativeSignature, TESTNET_SYSTEM_ID);
    const digest = sig.getIdentityHash({ version: info.version, hash_type: info.hashtype, height: info.height });
    // Mobile hashes raw UTF-8. verifyMessage uses a different length-prefixed hash.
    check(await this.client.verifyHash(sig.identityID, nativeSignature, digest, innerState.historical, TESTNET_SYSTEM_ID), 'Invalid image signature.');
    return { identityId: sig.identityID, systemId: sig.systemID, nativeSignature, identity: innerState.identity, displayIdentity: innerState.displayIdentity };
  }
}
