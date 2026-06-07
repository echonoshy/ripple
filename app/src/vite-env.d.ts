/// <reference types="vite/client" />

declare function test(name: string, fn: () => unknown | Promise<unknown>): void;
