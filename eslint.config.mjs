import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      'packages/db/generated/**',
      'packages/db/prisma/migrations/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
    },
  },

  // `consistent-type-imports` is applied everywhere EXCEPT apps/api.
  //
  // NestJS resolves constructor dependencies at runtime from the
  // `design:paramtypes` metadata that `emitDecoratorMetadata` writes. A
  // type-only import is erased during compilation, so the metadata degrades to
  // `Object` and DI fails with "Nest can't resolve dependencies" — and
  // `@Body()` DTOs stop being validated, because ValidationPipe needs the class
  // as a runtime value too. The rule's autofix silently introduces exactly that
  // bug, so it must not run over decorator-based code.
  {
    files: ['packages/**/*.ts', 'apps/web/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },

  // TECHNICAL_DESIGN.md §3: no raw SQL in core code. Prisma's escape hatches
  // bypass the ORM's dialect abstraction and silently break the non-Postgres
  // targets. If reporting genuinely needs raw SQL, it goes behind a per-dialect
  // adapter with an explicit eslint-disable and a comment saying why.
  {
    files: ['apps/api/**/*.ts', 'packages/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'MemberExpression[property.name=/^\\$(queryRaw|queryRawUnsafe|executeRaw|executeRawUnsafe)$/]',
          message:
            'Raw SQL is banned in core code (TECHNICAL_DESIGN.md §3) — it breaks the MySQL/SQLite targets. Use Prisma query methods, or put it behind a per-dialect adapter with an explicit eslint-disable.',
        },
      ],
    },
  },

  {
    files: ['**/*.config.*', '**/scripts/**', '**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  prettier,
);
