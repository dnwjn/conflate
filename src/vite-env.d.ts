/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** Set by `pnpm run dev:stub` to exercise the update UI with canned data (see src/update.ts). */
    readonly VITE_STUB_UPDATE?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
