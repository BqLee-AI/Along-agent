import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "**/.next/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["apps/web/**/*.{ts,tsx,js,jsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date']",
          message:
            "D2: apps/web MUST NOT construct Date (display layer does not compute time).",
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message:
            "D2: apps/web MUST NOT call Date.now() (display layer does not compute time).",
        },
      ],
    },
  },
);
