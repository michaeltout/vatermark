// Vatermark Cases (beta): a signed, hash-chained review workflow for clinical images (CASES.md).
// Everything the feature needs lives in this folder; the app mounts it with one call and is otherwise unchanged.
export { mountCaseRoutes, type CaseRoutes, type CaseRouteOptions } from './routes.js';
export { CasesVerusAdapter, isCasesAdapter, type CasesAdapter } from './verus.js';
export { verifyPackage, formatReport } from './verify-package.js';
