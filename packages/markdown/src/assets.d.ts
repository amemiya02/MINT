// Assets imported through the bundler (Vite): `?raw` gives the file's text,
// `?inline` a base64 data URI of the file.
declare module "*?raw" {
  const text: string;
  export default text;
}

declare module "*?inline" {
  const dataUri: string;
  export default dataUri;
}
