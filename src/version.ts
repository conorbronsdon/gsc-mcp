import { createRequire } from "node:module";

// package.json is the single source of the version. It sits one level above
// both src/ (tests) and dist/ (the published build), and npm always ships it.
const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export const VERSION: string = pkg.version;
