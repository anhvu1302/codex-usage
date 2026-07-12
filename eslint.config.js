import eslint from "@eslint/js";
import importX from "eslint-plugin-import-x";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import security from "eslint-plugin-security";
import tailwindcss from "eslint-plugin-tailwindcss";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "build-server/**",
      "coverage/**",
      "dist/**",
      "drizzle/**",
      "eslint.config.js",
      "node_modules/**",
      "prettier.config.mjs",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  jsxA11y.flatConfigs.recommended,
  reactHooks.configs.flat.recommended,
  security.configs.recommended,
  {
    ...tseslint.configs.disableTypeChecked,
    files: ["**/*.{cjs,js,mjs}"],
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { __dirname: "readonly", module: "readonly" },
      sourceType: "commonjs",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "import-x": importX,
      tailwindcss,
    },
    settings: {
      "import-x/resolver": {
        typescript: true,
      },
      tailwindcss: {
        cssConfigPath: "src/web/index.css",
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "import-x/no-cycle": "error",
      "import-x/no-duplicates": "error",
      "react-hooks/incompatible-library": "off",
      "security/detect-non-literal-fs-filename": "off",
      "tailwindcss/classnames-order": "off",
      "tailwindcss/no-custom-classname": "off",
    },
  },
  {
    files: ["**/*.config.{ts,js}", "src/**/*.test.ts", "e2e/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
);
