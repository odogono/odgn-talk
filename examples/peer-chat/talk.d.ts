// page.ts imports page.talk as its text, as Bun's bundler does.
declare module '*.talk' {
  const source: string;
  export default source;
}
