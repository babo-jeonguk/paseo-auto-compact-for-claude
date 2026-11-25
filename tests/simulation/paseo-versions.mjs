// Paseo CLI versions pinned in package.json, by the alias each is installed under.
// The native and restart runners both resolve a requested version here.
export const paseoPackages = new Map([
  ['0.16.2', '@getpaseo/cli-0-16-2'],
  ['0.17.0-beta.1', '@getpaseo/cli-0-17-beta'],
  ['0.17.1', '@getpaseo/cli-0-17-1'],
]);
