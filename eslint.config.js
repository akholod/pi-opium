import metarhia from 'eslint-config-metarhia';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['node_modules/', '.spiral/', '.omc/', '.pi/'] },
  ...metarhia,
  ...tseslint.configs.recommended,
  {
    languageOptions: { sourceType: 'module' },
    rules: {
      // typebox's schema builders are capitalized factory functions.
      'new-cap': ['error', { capIsNewExceptionPattern: '^Type\\.' }],
      // Prettier keeps parens in spreads: ...(a ? b : c).
      'no-extra-parens': 'off',
      // Prettier picks double quotes for strings containing an apostrophe.
      quotes: ['error', 'single', { avoidEscape: true }],
      // TypeScript resolves names; the core rules misread type-only syntax.
      // Test titles are single string literals that cannot be wrapped.
      'max-len': ['error', { code: 80, ignorePattern: '^\\s*test\\(' }],
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
];
