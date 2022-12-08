/* eslint-env node */

module.exports = {
    root: true,
    extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
    parser: '@typescript-eslint/parser',
    plugins: ['@typescript-eslint'],
    ignorePatterns: [
        "dist/",
        "typedoc/"
    ],

    rules: {
        // Suggestions
        "@typescript-eslint/no-empty-function": "off",

        // Types
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/ban-types": "off",
        "@typescript-eslint/no-non-null-assertion": "off"
    }
};