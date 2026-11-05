// REQ-CMDB-013 REQ-CMDB-016 — callback types for the CMDB components, kept in a .ts module: the guard reads an arrow type
// with a generic on one line of a .tsx file as JSX text.
export type AsyncAction = () => Promise<void>;
