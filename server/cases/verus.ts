import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  VerusAdapter, VerusError, TESTNET_SYSTEM_ID, check, same, rawId, compact, compactId, requestId, signatureWrapper, exactParse,
  type ChainIdentity, type RequestInput, type ResponseInput, type SignedRequest, type VerifiedResponse,
} from '../verus.js';

const require = createRequire(import.meta.url);
const P = require('verus-typescript-primitives') as typeof import('verus-typescript-primitives');
type Request = InstanceType<typeof P.GenericRequest>;

/**
 * Chain access for Cases. Like the metadata adapter, it extends the Vatermark
 * adapter without changing it: the app's own signing flow stays exactly as it
 * is, and this class adds a second statement profile (case statements) with
 * the same hardened request and callback checks, plus what the workflow
 * needs: identity lookup by name, the block a statement is issued against,
 * statement verification for the independent verifier, identity evidence for
 * exports, and service-signed export attestations.
 */
const CASE = 'VC-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}';
const I_ADDRESS = 'i[1-9A-HJ-NP-Za-km-z]{33}';
const ISO_TIME = '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z';
export const CASE_NUMBER = new RegExp(`^${CASE}$`);
export const IDENTITY_ADDRESS = new RegExp(`^${I_ADDRESS}$`);
/** Coarse grammar of a clinical-workflow-event/v1 statement (CASES.md). protocol.ts enforces the per-type rules. */
export const CASE_STATEMENT = new RegExp(`^clinical-workflow-event/v1\\n[A-Za-z][^\\n]{0,159}\\ntype:(?:CASE_CREATED|TASK_ASSIGNED|TASK_ACCEPTED|TASK_REJECTED|TASK_WITHDRAWN|REVIEW_COMPLETED|CASE_CLOSED|CASE_REOPENED)\\ncase:${CASE}\\nseq:[1-9][0-9]{0,8}\\nprev:[0-9a-f]{64}\\nartifact:sha-256:[0-9a-f]{64}\\nactor:${I_ADDRESS}\\nactor-name:[^\\n:]{1,100}\\n(?:to:${I_ADDRESS}\\nto-name:[^\\n:]{1,100}\\n)?(?:task:[0-9a-f]{16}\\n)?(?:deadline:${ISO_TIME}\\n)?policy:[a-z0-9.-]{1,64}\\npolicy-hash:[0-9a-f]{64}\\nblock:[1-9][0-9]{0,9}:[0-9a-f]{64}\\nat:${ISO_TIME}\\nnonce:[0-9a-f]{40}$`);
/** The service identity's attestation over an export package (CASES.md). */
export const EXPORT_ATTESTATION = new RegExp(`^clinical-workflow-export-attestation/v1\\ncase:${CASE}\\nevents:(?:0|[1-9][0-9]{0,8})\\nhead:[0-9a-f]{64}\\nat:${ISO_TIME}$`);

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();
function caseStatement(message: string): void {
  check(CASE_STATEMENT.test(message), 'Unsupported case statement.');
}
/** Validate the complete 73-byte native vector and return the height it embeds. */
export function nativeSignatureHeight(native: string | Buffer): number {
  const bytes = Buffer.isBuffer(native) ? native : Buffer.from(native, 'base64');
  check(bytes.length === 73 && bytes[0] === 2 && bytes[1] === 5 && bytes[6] === 1 && bytes[7] === 65 && bytes[8]! >= 27 && bytes[8]! <= 34,
    'Requires one native Verus v2/SHA256 compact signature.');
  return bytes.readUInt32LE(2);
}
/** The stored DataPacketRequest must still be the one issued for this statement and request identifier. */
function parseCaseRequest(hex: string, expectedMessage: string, expectedId: string): Request {
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
/**
 * How a signer's keys relate to the record their signature was checked
 * against: unchanged, rotated (primary addresses differ), or revoked now.
 */
export function keyStateOf(atHeight: unknown, current: unknown): 'unchanged' | 'rotated' | 'revoked' {
  const then = (atHeight as { identity?: { primaryaddresses?: unknown } } | undefined)?.identity;
  const now = current as { status?: unknown; identity?: { primaryaddresses?: unknown; flags?: unknown } } | undefined;
  if (!now?.identity || now.status !== 'active' || ((Number(now.identity.flags) || 0) & 0x8000) !== 0) return 'revoked';
  const keys = (value: unknown) => Array.isArray(value) ? [...value].map(String).sort().join(',') : '';
  return keys(then?.primaryaddresses) === keys(now.identity.primaryaddresses) ? 'unchanged' : 'rotated';
}

export interface ChainBlock { height: number; hash: string; time: number }
export interface StatementCheck {
  /** Cryptographic validity against identity state at the signature's own height. */
  valid: boolean; height: number;
  /** Whether the identity is active now; undefined when only a supplied record was used (offline). */
  currentActive?: boolean; name?: string;
  /** The record used, so a verifier can report what it trusted; `current` is the live record when the chain was queried. */
  record: unknown; current?: unknown; source: 'chain' | 'supplied';
}
export interface IdentityEvidence { atHeight: ChainIdentity; current: ChainIdentity }

export class CasesVerusAdapter extends VerusAdapter {
  /**
   * Issue a case statement for signature in Verus Mobile. Same envelope and
   * checks as the app's image signing request; only the statement profile
   * differs, so an image request can never be mistaken for a case step.
   */
  async createCaseRequest(input: RequestInput): Promise<SignedRequest> {
    caseStatement(input.message);
    const url = new URL(input.callbackUrl);
    const responseMode = input.responseMode ?? 'redirect';
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

  /** Verify a wallet's signed GenericResponse to a case statement. Mirrors the app's callback checks for its own profile. */
  async verifyCaseResponse(input: ResponseInput): Promise<VerifiedResponse> {
    try { return await this.verifyParsedCaseResponse(input); }
    catch (error) {
      if (error instanceof VerusError) throw error;
      throw new VerusError('INVALID_SIGNATURE', 'Malformed or invalid wallet response.');
    }
  }

  private async verifyParsedCaseResponse(input: ResponseInput): Promise<VerifiedResponse> {
    caseStatement(input.message);
    const expectedId = requestId(input.requestIdHex).toIAddress();
    const request = parseCaseRequest(input.requestHex, input.message, expectedId);
    const response = exactParse(new P.GenericResponse(), input.body);
    check(response.version.eqn(1), 'Unsupported response version.');
    if (!response.isTestnet()) throw new VerusError('UNSUPPORTED_NETWORK', 'Only VRSCTEST responses are supported.');
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
    check(data.version.eqn(1) && data.values.length === 1, 'Expected exactly one statement signature.');
    const value = data.values[0]!;
    check(Object.keys(value).length === 1, 'Unexpected data entries.');
    const sig = value[P.SignatureDataKey.vdxfid];
    check(sig instanceof P.SignatureData && sig.version.eqn(1) && sig.sigType.eqn(1) && sig.hashType.eqn(5), 'Unsupported inner signature wrapper.');
    check(!sig.vdxfKeys.length && !sig.vdxfKeyNames.length && !sig.boundHashes.length, 'Unexpected inner signature context.');
    if (sig.systemID !== TESTNET_SYSTEM_ID) throw new VerusError('UNSUPPORTED_NETWORK', 'Only VRSCTEST signatures are supported.');
    check(sig.identityID === outer.identityId && same(sig.signatureHash, sha256(input.message)), 'Statement signer or signed text mismatch.');
    const height = nativeSignatureHeight(sig.signatureAsVch);
    const innerState = await this.loadIdentity({ identityId: sig.identityID, systemId: sig.systemID, testnet: true, signingHeight: height });
    check(!innerState.identity.revoked && innerState.currentActive, 'The signing identity is revoked or inactive.');
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
    check(await this.client.verifyHash(sig.identityID, nativeSignature, digest, innerState.historical, TESTNET_SYSTEM_ID), 'Invalid statement signature.');
    return { identityId: sig.identityID, systemId: sig.systemID, nativeSignature, identity: innerState.identity, displayIdentity: innerState.displayIdentity };
  }

  /** Resolve a VRSCTEST identity by name (`name@`) or i-address when a case step names a party. */
  async lookupIdentity(query: string): Promise<{ id: string; name: string; active: boolean }> {
    const trimmed = query.trim();
    const isAddress = IDENTITY_ADDRESS.test(trimmed);
    check(isAddress || /^[A-Za-z0-9][A-Za-z0-9._ -]{0,62}[A-Za-z0-9.]?@?$/.test(trimmed), 'Enter a VerusID name such as name@ or an i-address.');
    if (isAddress) rawId(trimmed);
    const lookup = isAddress || trimmed.endsWith('@') ? trimmed : `${trimmed}@`;
    let record: ChainIdentity;
    try { record = await this.chain(() => this.client.interface.getIdentity(lookup)); }
    catch { throw new VerusError('CHAIN_UNAVAILABLE', 'That identity was not found on VRSCTEST, or the chain service is unavailable.'); }
    const identity = record?.identity;
    if (!identity || typeof identity.identityaddress !== 'string' || identity.systemid !== TESTNET_SYSTEM_ID) {
      throw new VerusError('UNSUPPORTED_NETWORK', 'Only VRSCTEST identities are supported.');
    }
    rawId(identity.identityaddress);
    if (isAddress && identity.identityaddress !== trimmed) throw new VerusError('CHAIN_UNAVAILABLE', 'The chain service returned a mismatched identity.');
    const active = record.status === 'active' && ((identity.flags ?? 0) & 0x8000) === 0;
    return { id: identity.identityaddress, name: identity.name || identity.identityaddress, active };
  }

  /** The chain records an accepted signature was verified against: at its height, and now. Kept with the event for exports. */
  async identityEvidence(identityId: string, height: number): Promise<IdentityEvidence> {
    const state = await this.loadIdentity({ identityId, systemId: TESTNET_SYSTEM_ID, testnet: true, signingHeight: height });
    const current = await this.chain(() => this.client.interface.getIdentity(identityId));
    this.validateRecord(current, identityId);
    return { atHeight: state.historical, current };
  }

  /** The block at a height, or the chain tip when no height is given; statements bind the tip the server observed. */
  async chainBlock(height?: number): Promise<ChainBlock> {
    const target = height ?? await this.tip();
    check(Number.isSafeInteger(target) && target >= 1 && target <= 0xffff_ffff, 'Invalid block height.');
    const block = await this.chain(() => this.client.interface.getBlock(String(target))) as { hash?: unknown; time?: unknown };
    if (typeof block.hash !== 'string' || !/^[0-9a-f]{64}$/.test(block.hash) || !Number.isSafeInteger(block.time)) {
      throw new VerusError('CHAIN_UNAVAILABLE', 'The chain service returned an invalid block.');
    }
    return { height: target, hash: block.hash, time: block.time as number };
  }

  /**
   * Verify a native signature over a UTF-8 statement for an identity, using the
   * identity state at the signature's own height. With `record` supplied the
   * check is offline against that record; otherwise the chain is queried and
   * the current revocation state is reported as well. This serves the
   * independent verifier; wallet callbacks go through verifyCaseResponse.
   */
  async verifyStatement(input: { identityId: string; statement: string; nativeSignature: string; record?: unknown }): Promise<StatementCheck> {
    rawId(input.identityId);
    const height = nativeSignatureHeight(input.nativeSignature);
    const wrapper = new P.VerifiableSignatureData({
      version: P.VerifiableSignatureData.TYPE_VERUSID_DEFAULT, isTestnet: true,
      systemID: compact(TESTNET_SYSTEM_ID), identityID: compact(input.identityId),
    });
    const digest = wrapper.getIdentityHash(height, sha256(input.statement));
    let record: ChainIdentity; let current: ChainIdentity | undefined; let currentActive: boolean | undefined; let name: string | undefined; let source: StatementCheck['source'];
    if (input.record !== undefined) {
      record = input.record as ChainIdentity; source = 'supplied';
      const authority = record?.identity;
      check(!!authority && authority.identityaddress === input.identityId && authority.minimumsignatures === 1 && Array.isArray(authority.primaryaddresses) && authority.primaryaddresses.length > 0, 'The supplied identity record is unusable.');
      name = authority.name;
    } else {
      const evidence = await this.identityEvidence(input.identityId, height);
      record = evidence.atHeight; current = evidence.current; source = 'chain';
      currentActive = current.status === 'active' && ((current.identity.flags ?? 0) & 0x8000) === 0;
      name = current.identity.name;
    }
    let valid = false;
    try { valid = await this.client.verifyHash(input.identityId, input.nativeSignature, digest, record, TESTNET_SYSTEM_ID); } catch { valid = false; }
    return { valid, height, currentActive, name, record, current, source };
  }

  /** Sign a UTF-8 statement with the service identity (export attestations). Never used for workflow events, which clinicians sign themselves. */
  async signStatement(statement: string): Promise<{ native: string; identityId: string; name: string; height: number }> {
    const { height, historical } = await this.service();
    const wrapper = new P.VerifiableSignatureData({
      version: P.VerifiableSignatureData.TYPE_VERUSID_DEFAULT, isTestnet: true,
      systemID: compact(TESTNET_SYSTEM_ID), identityID: compact(this.serviceId!),
    });
    const digest = wrapper.getIdentityHash(height, sha256(statement));
    let native: string;
    try { native = await this.client.signHash(this.serviceId!, digest, this.serviceWif!, historical, height, TESTNET_SYSTEM_ID); }
    catch { throw new VerusError('SERVICE_UNAVAILABLE', 'The service signing key is invalid or unauthorized.'); }
    if (!await this.client.verifyHash(this.serviceId!, native, digest, historical, TESTNET_SYSTEM_ID)) throw new VerusError('SERVICE_UNAVAILABLE', 'The service attestation could not be verified.');
    nativeSignatureHeight(native);
    return { native, identityId: this.serviceId!, name: historical.identity.name || this.serviceId!, height };
  }
}
/** What the case routes need from the chain. */
export type CasesAdapter = Pick<CasesVerusAdapter, 'status' | 'resolveIdentity' | 'createCaseRequest' | 'verifyCaseResponse' | 'lookupIdentity' | 'identityEvidence' | 'chainBlock' | 'verifyStatement' | 'signStatement'>;
const CASES_METHODS = ['status', 'resolveIdentity', 'createCaseRequest', 'verifyCaseResponse', 'lookupIdentity', 'identityEvidence', 'chainBlock', 'verifyStatement', 'signStatement'] as const;
/** True for a CasesVerusAdapter or any object that provides the same methods (such as a test double). */
export function isCasesAdapter(value: unknown): value is CasesAdapter {
  return !!value && typeof value === 'object' && CASES_METHODS.every(method => typeof (value as Record<string, unknown>)[method] === 'function');
}
