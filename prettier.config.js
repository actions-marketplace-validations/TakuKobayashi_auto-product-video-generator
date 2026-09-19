// The workspace package.json has no `type: module`, so keep this JavaScript
// config in CommonJS format. This prevents Node from reparsing it as ESM every
// time `pnpm run format` starts.
/** @type {import('prettier').Config} */
const config = {
  semi: true,
  singleQuote: true,
  trailingComma: 'es5',
  printWidth: 100,
  tabWidth: 2,
};

module.exports = config;
