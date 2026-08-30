/** Minimal type surface for the `react-dom` platform module used by the client
 * bundle. The runtime resolves `react-dom` from the loader module table (it is
 * a `PLATFORM_MODULES` entry), and only `createPortal` is used here — a local
 * declaration avoids a @types/react-dom dev dependency. */
declare module 'react-dom' {
  import type { ReactNode } from 'react'
  /** Render `children` into `container` outside the current React tree. */
  export function createPortal(children: ReactNode, container: Element | DocumentFragment, key?: null | string): ReactNode
}
