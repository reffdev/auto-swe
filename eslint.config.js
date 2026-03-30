import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import jest from "eslint-plugin-jest";
import testingLibrary from "eslint-plugin-testing-library";
import unusedImports from "eslint-plugin-unused-imports";

export default tseslint.config(
  // Global ignores
  {
    ignores: ["dist/", "node_modules/", "*.config.*", "jest.setup.ts"],
  },

  // TypeScript strict type-checked base
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ["tsconfig.json", "tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Off — not catching real bugs in this codebase
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-unused-vars": "off", // handled by unused-imports plugin
      "@typescript-eslint/no-redundant-type-constituents": "off", // fires on error-typed values from libraries
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "off", // too strict for .catch(err => ...)

      // Off — these fire on untyped third-party APIs (AI SDK, component libs) and standard patterns
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",

      // Adjusted errors
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
      "@typescript-eslint/require-await": "off", // many async fns conform to async interfaces without await
      "@typescript-eslint/no-confusing-void-expression": "off", // arrow shorthand returns are fine
      "@typescript-eslint/restrict-plus-operands": "off", // string + number concatenation is fine
      "@typescript-eslint/only-throw-error": "off", // sometimes throw non-Error values on purpose
      "@typescript-eslint/no-base-to-string": "off", // too strict for template literals
    },
  },

  // Unused imports — all files
  {
    plugins: { "unused-imports": unusedImports },
    rules: {
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "warn",
        { vars: "all", varsIgnorePattern: "^_", args: "after-used", argsIgnorePattern: "^_" },
      ],
    },
  },

  // React + hooks + a11y — frontend files only
  {
    files: ["src/frontend/**/*.{ts,tsx}"],
    plugins: {
      react,
      "react-hooks": reactHooks,
      "jsx-a11y": jsxA11y,
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      "react/no-children-prop": "off", // used by component library patterns
      // React Compiler rules — too strict for this codebase
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "jsx-a11y/click-events-have-key-events": "warn",
      "jsx-a11y/no-static-element-interactions": "warn",
      "jsx-a11y/no-autofocus": "off", // autofocus is fine in modals
      "jsx-a11y/label-has-associated-control": ["warn", { assert: "either" }],
    },
  },

  // Components folder (also React)
  {
    files: ["src/components/**/*.{ts,tsx}"],
    plugins: {
      react,
      "react-hooks": reactHooks,
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "off",
    },
  },

  // Jest + Testing Library — test files only
  {
    files: ["**/*.test.{ts,tsx}"],
    plugins: {
      jest,
      "testing-library": testingLibrary,
    },
    rules: {
      ...jest.configs.recommended.rules,
      "jest/expect-expect": "error",
      "jest/no-conditional-expect": "error",
      "jest/no-standalone-expect": "error",
      "jest/no-conditional-in-test": "off", // many tests legitimately use conditionals
      "jest/valid-expect": "error",
      ...testingLibrary.configs.react.rules,
      "testing-library/no-node-access": "off", // querySelector is legitimately needed in some tests
      "testing-library/render-result-naming-convention": "off",
      // Relax strict type checking in tests
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
