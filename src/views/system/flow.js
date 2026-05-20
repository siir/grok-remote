// Live agent flow page.
//
// This file is a tiny vanilla wrapper. All the actual rendering lives in
// flow.jsx, which we load lazily so the React + @xyflow/react bundle only
// ships to users that actually navigate to #/flow.

let activeContainer = null;
let activeRoot      = null;
// Generation counter guards against an unmount that races a still-pending
// dynamic import: if the user leaves the page before flow.jsx resolves we
// must not paint into a container that is no longer ours.
let mountGeneration = 0;

export async function mount(container, route) {
  activeContainer = container;
  container.replaceChildren();

  const myGen = ++mountGeneration;

  // Lazy-load React + the flow component together. This keeps the rest of
  // the dashboard free of the React runtime until someone opens this page.
  const [{ createElement }, { createRoot }, { default: FlowApp }] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('./flow.jsx'),
  ]);

  if (myGen !== mountGeneration || activeContainer !== container) {
    // unmounted (or remounted) while we were loading; bail.
    return;
  }

  activeRoot = createRoot(container);
  activeRoot.render(createElement(FlowApp, { route }));
}

export function unmount() {
  mountGeneration++;
  if (activeRoot) {
    try { activeRoot.unmount(); } catch { /* ignore */ }
    activeRoot = null;
  }
  if (activeContainer) {
    activeContainer.replaceChildren();
    activeContainer = null;
  }
}
