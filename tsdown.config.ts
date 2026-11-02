/** Runtime output for the plugin; `tsc` owns type checking. */
export default {
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  dts: false,
  clean: true,
}
