/** Local operator tool. Never imported by the web server. See GIFT_CARDS.md. */
import { createECDH, createHash, randomBytes, randomInt } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { GenericRequest, SpendableKeyDetails, SpendableKeyDetailsOrdinalVDXFObject,
  nameAndParentAddrToIAddr, toBase58Check } from 'verus-typescript-primitives';
import { prepareCommitment, prepareCommitmentFeeFunding, GiftOperationError, type GiftRpc, type PreparedGiftTransaction, type GiftNameReservation } from './gift-commitment.js';
import { GIFT_TESTNET_SYSTEM, ensureGiftReferrals, assertNativeReferralPayouts, type GiftReferralState } from './gift-referrals.js';
import { repairConflictedGiftRegistrations, type RetiredGiftRegistration } from './gift-registration.js';
export const GIFT_NATIVE_PARENT = 'vrsctest@';

const require = createRequire(import.meta.url);
const { entropyToMnemonic } = require('bip39') as { entropyToMnemonic: (entropy: string) => string };
const run = promisify(execFile);
const DEFAULT_CLI = [resolve(dirname(fileURLToPath(import.meta.url)), '../../VerusCoin/src/verus'),
  resolve(dirname(fileURLToPath(import.meta.url)), '../../VerusCoin/verus'),
  '/Applications/Verus-Desktop.app/Contents/Resources/app/assets/bin/osx/verusd/verus'].find(path => existsSync(path)) || 'verus';
const DEFAULT_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '../.data/gift-batches');
const ADJECTIVES = ('amber azure brave bright brisk calm clever coral cosmic cozy crisp daring dawn eager emerald fair fancy fast gentle golden grand happy hardy hazel honest icy jade jolly kind lively lucky lunar mellow merry misty noble ocean olive patient peaceful quiet rapid regal rosy royal sandy shiny silent silver snowy solar steady stellar sunny swift tender tidy tiny tranquil trusty vivid warm wild wise young').split(' ');
const NOUNS = ('albatross badger bear bee birch bison blossom breeze brook butterfly cactus cedar cherry cloud comet coral crane creek cricket crystal cypress daisy deer dolphin dragon dragonfly eagle elm falcon fern finch firefly fox garden gecko grove hare hawk heron hill ibis island jaguar jasmine jay juniper kestrel kite koala lake lark leaf lemur leopard lily lion lotus lynx maple meadow moon moss mountain narwhal oak ocean olive orchid otter owl panda panther parrot peach pearl pebble penguin petal phoenix pine planet plum polar poppy puffin quail rabbit raven reef robin rose sage salmon seal shark shell sky sparrow spruce squirrel star stone summit swan tiger tulip turtle valley violet whale willow wolf wren zebra').split(' ');

type SavedTx = PreparedGiftTransaction & { broadcast?: boolean };
export type GiftCardDraft = {
  id: string; identityName: string; identityId: string; address: string; walletUri: string;
  commitment?: SavedTx & { namereservation: GiftNameReservation }; registration?: SavedTx;
  registrationFundingAddress?: string; retiredRegistrations?: RetiredGiftRegistration[];
};
export type GiftBatch = {
  format: 'vatermark-gift-batch'; version: 1; network: 'VRSCTEST'; parentName: typeof GIFT_NATIVE_PARENT;
  batchId: string; createdAt: string; cards: GiftCardDraft[]; referrals?: GiftReferralState;
  registrationFunding?: SavedTx & { cardIds: string[] };
  controlAddress?: string; commitmentFeeFunding?: SavedTx & { allocations: { cardId: string; vout: number }[] }; feeFunding?: SavedTx[]; funding?: SavedTx; completedAt?: string; inventoryPath?: string;
};

/** Directory and file permissions protect bearer seeds. Atomic replace + fsync
 * ensures the exact signed transaction is durable before any broadcast. */
export async function atomicWritePrivate(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(data, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export function createGiftRpc(binary = process.env.VERUS_CLI || DEFAULT_CLI): GiftRpc {
  return async (method, params = []) => {
    // The daemon reads its existing local conf; RPC passwords and gift private keys
    // never appear in argv, environment, logs, or exported inventories separately.
    try {
      const result = await run(binary, ['-chain=VRSCTEST', method, ...params.map(value =>
        typeof value === 'string' ? value : JSON.stringify(value))], { timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
      const value = result.stdout.trim();
      if (!value) return null;
      try { return JSON.parse(value); } catch { return value; }
    } catch (error) {
      const stderr = String((error as { stderr?: string }).stderr ?? '');
      const code = /error code:\s*(-?\d+)/i.exec(stderr);
      const daemonMessage = /error message:\s*([\s\S]*)/i.exec(stderr)?.[1]?.trim();
      const failure = new GiftOperationError(`${method}: ${daemonMessage?.slice(0, 1000) || 'Local daemon command failed or timed out; resume this same state file.'}`) as Error & { code?: number };
      failure.code = code ? Number(code[1]) : undefined;
      throw failure;
    }
  };
}

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
function missing(error: unknown): boolean { return (error as { code?: number }).code === -5; }
export async function knownTransaction(rpc: GiftRpc, txid: string): Promise<any | undefined> {
  try { return await rpc('getrawtransaction', [txid, 1]); }
  catch (error) { if (missing(error)) return undefined; throw error; }
}
export async function waitForTransaction(rpc: GiftRpc, txid: string, log = console.log): Promise<void> {
  let attempts = 0;
  while (true) {
    const transaction = await knownTransaction(rpc, txid);
    if (Number(transaction?.confirmations) >= 1) return;
    if (Number(transaction?.confirmations) < 0) throw new GiftOperationError('A saved transaction is conflicted. Investigate this batch before continuing.');
    if (attempts++ % 4 === 0) log(`Waiting for transaction ${txid.slice(0, 12)} to confirm.`);
    await sleep(15000);
  }
}
async function relay(rpc: GiftRpc, transaction: SavedTx, persist: () => Promise<void>): Promise<void> {
  const known = await knownTransaction(rpc, transaction.txid);
  if (known?.confirmations < 0) throw new GiftOperationError('Saved gift transaction is conflicted.');
  if (!known) {
    const returned = await rpc('sendrawtransaction', [transaction.hex]);
    if (returned !== transaction.txid) throw new GiftOperationError('Broadcast returned a different transaction ID.');
  }
  transaction.broadcast = true;
  await persist();
}
async function prepareHex(rpc: GiftRpc, hex: unknown): Promise<SavedTx> {
  if (typeof hex !== 'string' || !/^[0-9a-f]+$/i.test(hex) || hex.length % 2) throw new GiftOperationError('Expected signed transaction hex.');
  const decoded = await rpc('decoderawtransaction', [hex]);
  if (!/^[0-9a-f]{64}$/i.test(decoded.txid)) throw new GiftOperationError('Invalid prepared transaction ID.');
  return { hex, txid: decoded.txid };
}
async function payment(rpc: GiftRpc, outputs: Record<string, number>): Promise<SavedTx> {
  const raw = await rpc('createrawtransaction', [[], outputs]);
  const funded = await rpc('fundrawtransaction', [raw]);
  const signed = await rpc('signrawtransaction', [funded.hex]);
  if (!signed.complete) throw new GiftOperationError('Daemon could not sign the complete funding transaction.');
  return prepareHex(rpc, signed.hex);
}

/** Verus-Mobile keys.js -> agama-wallet-lib/keys.js uses SHA256 of the exact
 * BIP39 mnemonic text and iguana bit clamping, NOT a BIP32 derivation path. */
export function deriveGiftAddress(entropy: Buffer): string {
  if (entropy.length !== 32) throw new GiftOperationError('Gift entropy must contain 32 bytes.');
  const mnemonic = entropyToMnemonic(entropy.toString('hex'));
  const scalar = createHash('sha256').update(mnemonic, 'utf8').digest();
  scalar[0] &= 248; scalar[31] &= 127; scalar[31] |= 64;
  const key = createECDH('secp256k1'); key.setPrivateKey(scalar);
  const publicKey = key.getPublicKey(undefined, 'compressed');
  const hash160 = createHash('ripemd160').update(createHash('sha256').update(publicKey).digest()).digest();
  scalar.fill(0);
  return toBase58Check(hash160, 60);
}
export function makeGiftCard(leaf: string, parentId: string, entropy = randomBytes(32)): GiftCardDraft {
  if (parentId !== GIFT_TESTNET_SYSTEM) throw new GiftOperationError('Gift cards require native VRSCTEST identities.');
  const request = new GenericRequest({ flags: GenericRequest.FLAG_IS_TESTNET, details: [
    new SpendableKeyDetailsOrdinalVDXFObject({ data: new SpendableKeyDetails({
      data: entropy, seedFormat: SpendableKeyDetails.SEED_FORMAT_BIP39,
      encryptionFormat: SpendableKeyDetails.ENCRYPTION_FORMAT_NONE,
    }) }),
  ] });
  return {
    id: randomBytes(16).toString('hex'), identityName: `${leaf}.${GIFT_NATIVE_PARENT}`,
    identityId: nameAndParentAddrToIAddr(leaf, parentId), address: deriveGiftAddress(entropy),
    walletUri: request.toWalletDeeplinkUri(),
  };
}
function chooseLeaf(used: Set<string>): string {
  for (let attempt = 0; attempt < 100000; attempt++) {
    const leaf = ADJECTIVES[randomInt(ADJECTIVES.length)] + NOUNS[randomInt(NOUNS.length)];
    if (!used.has(leaf)) { used.add(leaf); return leaf; }
  }
  throw new GiftOperationError('The adjective/noun name pool is exhausted; extend the word lists.');
}
export async function createBatch(count: number, directory: string): Promise<GiftBatch> {
  if (!Number.isInteger(count) || count < 1 || count > 200) throw new GiftOperationError('Batch count must be between 1 and 200.');
  const used = new Set<string>();
  let entries: string[] = [];
  try { entries = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const file of entries.filter(name => name.endsWith('.state.json'))) {
    let previous: any;
    try { previous = JSON.parse(await readFile(resolve(directory, file), 'utf8')); }
    catch { throw new GiftOperationError('An existing private batch journal could not be read. No private contents are printed.'); }
    for (const card of previous.cards ?? []) if (typeof card.identityName === 'string') used.add(card.identityName.split('.')[0]);
  }
  const parentId = GIFT_TESTNET_SYSTEM;
  return { format: 'vatermark-gift-batch', version: 1, network: 'VRSCTEST', parentName: GIFT_NATIVE_PARENT,
    batchId: randomBytes(16).toString('hex'), createdAt: new Date().toISOString(),
    cards: Array.from({ length: count }, () => makeGiftCard(chooseLeaf(used), parentId)),
  };
}
function assertBatch(batch: GiftBatch): void {
  if (batch.format !== 'vatermark-gift-batch' || batch.version !== 1 || batch.network !== 'VRSCTEST' ||
      batch.parentName !== GIFT_NATIVE_PARENT || !/^[0-9a-f]{32}$/.test(batch.batchId) || !Array.isArray(batch.cards) ||
      batch.cards.length < 1 || batch.cards.length > 200) throw new GiftOperationError('Invalid private gift batch.');
  const identities = new Set<string>(), addresses = new Set<string>(), ids = new Set<string>();
  const parentId = GIFT_TESTNET_SYSTEM;
  for (const card of batch.cards) {
    const leaf = card.identityName.split('.')[0];
    const request = GenericRequest.fromWalletDeeplinkUri(card.walletUri);
    const detail = request.details[0];
    if (!request.isTestnet() || request.isSigned() || request.details.length !== 1 ||
        !(detail instanceof SpendableKeyDetailsOrdinalVDXFObject) || detail.data.isEncrypted() ||
        !detail.data.isBIP39() || detail.data.data.length !== 32 || deriveGiftAddress(detail.data.data) !== card.address ||
        card.identityName !== `${leaf}.${GIFT_NATIVE_PARENT}` || !/^[a-z]+$/.test(leaf) ||
        nameAndParentAddrToIAddr(leaf, parentId) !== card.identityId || !/^[0-9a-f]{32}$/.test(card.id) ||
        identities.has(card.identityId) || addresses.has(card.address) || ids.has(card.id)) throw new GiftOperationError('Gift batch contains invalid or duplicate cards.');
    identities.add(card.identityId); addresses.add(card.address); ids.add(card.id);
  }
}
async function lookupIdentity(rpc: GiftRpc, id: string): Promise<any | undefined> {
  try { return await rpc('getidentity', [id]); } catch (error) { if (missing(error)) return undefined; throw error; }
}
function assertGiftIdentity(result: any, card: GiftCardDraft, parentId: string): void {
  const identity = result?.identity;
  if (result.status !== 'active' || identity.identityaddress !== card.identityId || identity.parent !== parentId ||
      identity.minimumsignatures !== 1 || identity.primaryaddresses?.length !== 1 || identity.primaryaddresses[0] !== card.address ||
      identity.revocationauthority !== card.identityId || identity.recoveryauthority !== card.identityId)
    throw new GiftOperationError(`Identity ${card.identityName} is not controlled exclusively by its gift card. Refusing to fund it.`);
}
/** Names on the native root may already be registered. Only uncommitted cards
 * can be renamed automatically; an existing saved commitment remains immutable. */
export async function resolveNativeNameCollisions(batch: GiftBatch, rpc: GiftRpc,
  persist: () => Promise<void>): Promise<void> {
  const used = new Set(batch.cards.map(card => card.identityName.split('.')[0]));
  for (const card of batch.cards) {
    let existing = await lookupIdentity(rpc, card.identityId);
    while (existing) {
      if (card.commitment || card.registration) {
        assertGiftIdentity(existing, card, GIFT_TESTNET_SYSTEM);
        if (!card.registration) throw new GiftOperationError('An existing identity has no saved registration transaction.');
        break;
      }
      const leaf = chooseLeaf(used);
      card.identityName = `${leaf}.${GIFT_NATIVE_PARENT}`;
      card.identityId = nameAndParentAddrToIAddr(leaf, GIFT_TESTNET_SYSTEM);
      await persist();
      existing = await lookupIdentity(rpc, card.identityId);
    }
  }
}
async function addressUtxos(rpc: GiftRpc, address: string): Promise<any[]> {
  return rpc('getaddressutxos', [{ addresses: [address] }]);
}

/** Allocate registration fees to distinct operator-owned R-addresses. The daemon
 * registeridentity wildcard selector can reuse mempool-spent inputs, so every
 * parallel registration must have its own confirmed funding address. Gift
 * addresses remain untouched until the final exact-1-VRSCTEST funding step. */
export async function prepareRegistrationFunding(batch: GiftBatch, rpc: GiftRpc,
  persist: () => Promise<void>): Promise<void> {
  const pending = batch.cards.filter(card => !card.registration);
  if (!pending.length) return;
  const giftAddresses = new Set(batch.cards.map(card => card.address));
  const assigned = new Set<string>();
  for (const card of batch.cards) if (card.registrationFundingAddress) {
    if (giftAddresses.has(card.registrationFundingAddress) || assigned.has(card.registrationFundingAddress))
      throw new GiftOperationError('Registration fee addresses must be distinct from every gift address and one another.');
    assigned.add(card.registrationFundingAddress);
  }
  if (batch.registrationFunding) {
    if (pending.some(card => !card.registrationFundingAddress || !batch.registrationFunding!.cardIds.includes(card.id)))
      throw new GiftOperationError('Saved registration funding does not cover every remaining card.');
    return;
  }
  for (const card of pending) if (!card.registrationFundingAddress) {
    const address = await rpc('getnewaddress');
    if (typeof address !== 'string' || !address.startsWith('R') || giftAddresses.has(address) || assigned.has(address))
      throw new GiftOperationError('Daemon returned an invalid or reused registration fee address.');
    card.registrationFundingAddress = address; assigned.add(address); await persist();
  }
  const prepared = await payment(rpc, Object.fromEntries(pending.map(card => [card.registrationFundingAddress!, 80.001])));
  batch.registrationFunding = { ...prepared, cardIds: pending.map(card => card.id) };
  await persist();
}

/** Fee-address discovery can include older operator change outputs because the
 * daemon may return previously used keypool addresses. Extra inputs are allowed
 * only when they were confirmed positive-value UTXOs at this exact fee address
 * before preparation. Zero-value commitments belonging to other cards never
 * enter the allowed fee set. */
export function assertRegistrationFundingInputs(transaction: any, commitment: { txid: string; vout: number },
  reserved: { txid: string; vout: number }, feeAddressOutputs: any[]): void {
  const key = (input: { txid: string; vout: number }) => `${input.txid}:${input.vout}`;
  const commitmentKey = key(commitment); const reservedKey = key(reserved);
  const allowed = new Set(feeAddressOutputs.filter(output => Number(output.satoshis) > 0)
    .map(output => `${output.txid}:${output.outputIndex}`));
  const inputs = transaction?.vin;
  if (!Array.isArray(inputs) || inputs.length < 2 || commitmentKey === reservedKey || !allowed.has(reservedKey) ||
      inputs.some(input => typeof input.txid !== 'string' || !Number.isSafeInteger(input.vout) || input.vout < 0) ||
      new Set(inputs.map(key)).size !== inputs.length || inputs.filter(input => key(input) === commitmentKey).length !== 1 ||
      inputs.filter(input => key(input) === reservedKey).length !== 1 ||
      inputs.some(input => key(input) !== commitmentKey && !allowed.has(key(input)))) {
    throw new GiftOperationError('Daemon registration used an unassigned fee source or an unexpected name commitment.');
  }
}

export async function executeBatch(batch: GiftBatch, statePath: string, rpc: GiftRpc,
  { anchorsOnly = false, chunkSize = 20, log = console.log } = {}): Promise<void> {
  assertBatch(batch);
  if (batch.completedAt) { log(`Batch already completed. Private inventory: ${batch.inventoryPath}`); return; }
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 20) throw new GiftOperationError('Chunk size must be between 1 and 20.');
  const persist = () => atomicWritePrivate(statePath, batch);
  const referrals = await ensureGiftReferrals({ rpc, state: batch, persist,
    waitForTx: txid => waitForTransaction(rpc, txid, log), log, allowBroadcast: true });
  if (anchorsOnly) { log('Operator referral anchors are ready; run this same state with --execute to issue the native gift identities.'); return; }
  if (!batch.controlAddress) { batch.controlAddress = referrals.controlAddress; await persist(); }
  // Resolve ordinary root-name collisions before buying any card commitment.
  // The entropy, bearer URI and funding address never change when renaming.
  await resolveNativeNameCollisions(batch, rpc, persist);
  await repairConflictedGiftRegistrations({ rpc, cards: batch.cards, persist });
  const needCommitment = batch.cards.filter(card => !card.commitment && !card.registration);
  if (needCommitment.length && !batch.commitmentFeeFunding) {
    // Independent confirmed inputs avoid the daemon's mempool ancestor limit.
    batch.commitmentFeeFunding = await prepareCommitmentFeeFunding(rpc, batch.controlAddress!, needCommitment.map(card => card.id));
    await persist();
  }
  if (batch.commitmentFeeFunding) {
    await relay(rpc, batch.commitmentFeeFunding, persist);
    await waitForTransaction(rpc, batch.commitmentFeeFunding.txid, log);
  }
  log(`Preparing ${batch.cards.length} independent name commitments.`);
  for (const card of batch.cards) {
    const existing = await lookupIdentity(rpc, card.identityId);
    if (existing) {
      assertGiftIdentity(existing, card, GIFT_TESTNET_SYSTEM);
      if (!card.registration) throw new GiftOperationError('An identity exists without a saved registration. Investigate the private batch journal.');
      continue;
    }
    if (!card.commitment) {
      const allocation = batch.commitmentFeeFunding?.allocations.find(item => item.cardId === card.id);
      if (!allocation) throw new GiftOperationError('Missing durable commitment fee allocation.');
      card.commitment = await prepareCommitment(rpc, card.identityName.split('.')[0], GIFT_TESTNET_SYSTEM,
        batch.controlAddress!, { txid: batch.commitmentFeeFunding!.txid, vout: allocation.vout }, referrals.referralId);
      await persist();
    }
    if (card.commitment.namereservation.referral !== referrals.referralId ||
        card.commitment.namereservation.parent !== GIFT_TESTNET_SYSTEM)
      throw new GiftOperationError('Saved card commitment does not match the native operator referral chain.');
    await relay(rpc, card.commitment, persist);
  }
  for (const card of batch.cards) if (card.commitment) await waitForTransaction(rpc, card.commitment.txid, log);
  await prepareRegistrationFunding(batch, rpc, persist);
  if (batch.registrationFunding) {
    await relay(rpc, batch.registrationFunding, persist);
    await waitForTransaction(rpc, batch.registrationFunding.txid, log);
  }
  for (let offset = 0; offset < batch.cards.length; offset += chunkSize) {
    const chunk = batch.cards.slice(offset, offset + chunkSize);
    log(`Registering identities ${offset + 1}–${offset + chunk.length} of ${batch.cards.length}.`);
    for (const card of chunk) {
      if (!card.registration) {
        const feeAddressOutputs = await addressUtxos(rpc, card.registrationFundingAddress!);
        const feeOutputs = feeAddressOutputs.filter(output =>
          output.txid === batch.registrationFunding?.txid && Number(output.satoshis) === 8000100000);
        if (feeOutputs.length !== 1) throw new GiftOperationError('Registration fee allocation is missing or has already been spent.');
        const hex = await rpc('registeridentity', [{ txid: card.commitment!.txid,
          namereservation: card.commitment!.namereservation, identity: {
            name: card.identityName.split('.')[0], parent: GIFT_TESTNET_SYSTEM,
            primaryaddresses: [card.address], minimumsignatures: 1,
            revocationauthority: card.identityId, recoveryauthority: card.identityId,
          } }, true, referrals.registrationFee, card.registrationFundingAddress]);
        const prepared = await prepareHex(rpc, hex);
        const decoded = await rpc('decoderawtransaction', [prepared.hex]);
        const commitment = await rpc('decoderawtransaction', [card.commitment!.hex]);
        const commitmentOutputs = commitment.vout.filter((output: any) => output.scriptPubKey?.commitmenthash?.hash);
        if (commitmentOutputs.length !== 1) throw new GiftOperationError('Saved name commitment output is ambiguous.');
        assertRegistrationFundingInputs(decoded, { txid: card.commitment!.txid, vout: commitmentOutputs[0].n },
          { txid: batch.registrationFunding!.txid, vout: feeOutputs[0].outputIndex }, feeAddressOutputs);
        assertNativeReferralPayouts(decoded, card.identityId, referrals.rebateIdentities);
        card.registration = prepared; await persist();
      }
      await relay(rpc, card.registration, persist);
    }
    for (const card of chunk) {
      await waitForTransaction(rpc, card.registration!.txid, log);
      assertGiftIdentity(await lookupIdentity(rpc, card.identityId), card, GIFT_TESTNET_SYSTEM);
    }
  }
  if (!batch.funding) {
    for (const card of batch.cards) {
      const utxos = await addressUtxos(rpc, card.address);
      if (utxos.some(output => Number(output.satoshis ?? 0) > 0))
        throw new GiftOperationError(`Gift address for ${card.identityName} already has funds without a saved funding transaction.`);
    }
    batch.funding = await payment(rpc, Object.fromEntries(batch.cards.map(card => [card.address, 1])));
    await persist();
  }
  await relay(rpc, batch.funding, persist);
  await waitForTransaction(rpc, batch.funding.txid, log);
  for (const card of batch.cards) {
    assertGiftIdentity(await lookupIdentity(rpc, card.identityId), card, GIFT_TESTNET_SYSTEM);
    const funded = (await addressUtxos(rpc, card.address)).filter(output => output.txid === batch.funding!.txid);
    if (funded.reduce((total, output) => total + Number(output.satoshis), 0) !== 100000000)
      throw new GiftOperationError(`Gift funding verification failed for ${card.identityName}.`);
  }
  const inventory = { format: 'vatermark-gift-inventory', version: 1, network: 'VRSCTEST', parent: GIFT_NATIVE_PARENT,
    batchId: batch.batchId, createdAt: batch.createdAt, cards: batch.cards.map(card => ({
      id: card.id, identityName: card.identityName, identityId: card.identityId, address: card.address,
      walletUri: card.walletUri, fundingTxid: batch.funding!.txid, registrationTxid: card.registration!.txid,
      amount: '1.00000000',
    })) };
  const inventoryPath = resolve(dirname(statePath), `${batch.batchId}.inventory.json`);
  await atomicWritePrivate(inventoryPath, inventory);
  batch.completedAt = new Date().toISOString(); batch.inventoryPath = inventoryPath; await persist();
  log(`Created and verified ${batch.cards.length} gift cards. Private inventory: ${inventoryPath}`);
  log('Each card holds exactly 1 VRSCTEST before the wallet claim fee (normally 0.0002 VRSCTEST). Nothing has been deployed.');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Local VRSCTEST gift batches\n  pnpm exec tsx scripts/generate-gifts.ts [--count 100] [--directory PATH]\n  pnpm exec tsx scripts/generate-gifts.ts --state PATH --execute [--anchors-only] [--chunk-size 20]\n\nWithout --execute, only a private resumable plan is created. Resume the SAME state file after interruption.\n--anchors-only registers the two operator referral anchors first; ordinary --execute then creates native VRSCTEST identities.\nVERUS_CLI may select the local Verus CLI; its existing daemon configuration supplies authentication.'); return;
  }
  const permitted = new Set(['--help', '--state', '--count', '--directory', '--execute', '--anchors-only', '--chunk-size']);
  const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  for (let i = 0; i < args.length; i++) {
    if (!permitted.has(args[i])) throw new GiftOperationError(`Unknown option: ${args[i]}`);
    if (['--state', '--count', '--directory', '--chunk-size'].includes(args[i])) {
      if (!args[++i] || args[i].startsWith('--')) throw new GiftOperationError('An option value is missing.');
    }
  }
  const directory = resolve(value('--directory') || DEFAULT_DIRECTORY);
  let statePath = value('--state') ? resolve(value('--state')!) : undefined;
  let batch: GiftBatch;
  if (statePath) {
    const metadata = await stat(statePath);
    if (metadata.mode & 0o077) throw new GiftOperationError('Private batch file permissions must be 0600.');
    try { batch = JSON.parse(await readFile(statePath, 'utf8')); }
    catch { throw new GiftOperationError('The private batch journal could not be read. No private contents are printed.'); }
    assertBatch(batch);
  } else {
    batch = await createBatch(Number(value('--count') ?? 100), directory);
    statePath = resolve(directory, `${batch.batchId}.state.json`);
    await atomicWritePrivate(statePath, batch);
  }
  console.log(`Private batch journal: ${statePath}`);
  console.log(`${batch.cards.length} cards; ${batch.cards.filter(card => card.registration).length} registrations prepared; ${batch.completedAt ? 'complete' : 'pending'}.`);
  if (!args.includes('--execute')) { console.log('Plan saved. No transactions were broadcast. Use --state with this path and --execute to continue.'); return; }
  const lockPath = resolve(dirname(statePath), '.generator.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new GiftOperationError('A generator lock already exists. Stop all generator processes and verify that the recorded process has exited before manually removing .generator.lock.');
  }
  try {
    await lock.writeFile(String(process.pid)); await lock.sync();
    await executeBatch(batch, statePath, createGiftRpc(), { anchorsOnly: args.includes('--anchors-only'), chunkSize: Number(value('--chunk-size') ?? 20) });
  } finally { await lock.close(); await unlink(lockPath); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof GiftOperationError ? error.message : 'Gift generation failed. Raw errors are suppressed because the journal contains bearer secrets; inspect daemon status and resume the same state file.'); process.exitCode = 1; });
}
