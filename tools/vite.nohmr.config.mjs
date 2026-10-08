// Vite config for automated playtests: no HMR / file watching, so concurrent edits by
// other people don't reload the page mid-test.
import base from '../vite.config.js';
export default { ...base, root: new URL('..', import.meta.url).pathname, server: { ...(base.server || {}), hmr: false, watch: null } };
