// @ts-check
import { defineConfig } from "eslint/config";

// No TypeScript-aware parser is installed for this Phase 0 scope
// (typescript-eslint is not in the approved dependency list), so this
// config lints plain JS sources only. TypeScript correctness is
// enforced separately by `npm run typecheck`.
export default defineConfig([
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "phase0-artifacts/**",
      "**/*.ts"
    ]
  },
  {
    files: ["fixtures/public/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: {
        document: "readonly",
        window: "readonly",
        fetch: "readonly",
        console: "readonly",
        AbortController: "readonly"
      }
    },
    rules: {
      "no-unused-vars": "warn",
      "no-undef": "error",
      eqeqeq: "warn"
    }
  }
]);
