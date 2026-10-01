// Vite's `?raw` imports (file contents as a string), used to read repo files inside workerd.
declare module "*?raw" {
  const content: string;
  export default content;
}
