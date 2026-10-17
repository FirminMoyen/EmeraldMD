/** Mermaid, in its own chunk: loaded the first time a note has a diagram. */

import mermaid from 'mermaid';

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });

export default mermaid;
