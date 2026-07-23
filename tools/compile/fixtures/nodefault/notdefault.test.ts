// A file matching the discovery glob but exporting no default — compile must reject it
// with a friendly, file-named error rather than crashing.
export const notATest = { id: "nope" };
