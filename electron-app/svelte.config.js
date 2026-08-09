import preprocess from 'svelte-preprocess';

export default {
  preprocess: preprocess({
    typescript: {
      tsconfigFile: './tsconfig.json'
    }
  }),
  compilerOptions: {
    enableSourcemap: true
  }
};

