/// <reference types="vite/client" />

/** An asset as a base64 `data:` URI string (the `cortex:data-uri` plugin in vite.config.ts). */
declare module '*?data-uri' {
  const uri: string;
  export default uri;
}
