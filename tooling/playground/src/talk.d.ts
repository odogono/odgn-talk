// A `.talk` file imported `with { type: 'text' }` is its source text.
declare module '*.talk' {
  const source: string;
  export default source;
}
