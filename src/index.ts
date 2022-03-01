import { transform } from './transform';
import { define, load } from './load';
import loadFederated from './federated'

interface Script extends Element {
  dataset: Record<string, string>;
}

if (typeof document !== 'undefined') {
  const scr: Script | null = document.querySelector('[data-main]');
  if (scr) {
    const attr = scr.getAttribute('data-main')
    if (attr) {
      loadFederated(new URL(attr, document.baseURI));
    }
  }
}

const VERSION = "0.0.1";

export { transform, define, load, loadFederated, VERSION };
