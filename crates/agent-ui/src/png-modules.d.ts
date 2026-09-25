// PNG asset imports (Vite returns the bundled URL string).
declare module "*.png" {
  const src: string;
  export default src;
}
