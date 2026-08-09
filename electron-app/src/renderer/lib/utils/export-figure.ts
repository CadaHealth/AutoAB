/**
 * Publication-quality figure export for SVG and HTML elements.
 * Supports SVG and PNG export via Electron save dialog or browser download.
 */

import html2canvas from 'html2canvas';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function saveBinary(data: Uint8Array, defaultFilename: string, filterName: string, extensions: string[], mimeType: string): Promise<void> {
  if (window.electronAPI) {
    const filePath = await window.electronAPI.saveFile({
      defaultPath: defaultFilename,
      filters: [
        { name: filterName, extensions },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (!filePath) return;
    let base64 = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < data.length; i += chunkSize) {
      base64 += String.fromCharCode.apply(null, Array.from(data.subarray(i, i + chunkSize)));
    }
    base64 = btoa(base64);
    const result = await window.electronAPI.writeBinaryFile(filePath, base64);
    if (!result.success) {
      alert(`Failed to save: ${result.error || 'Unknown error'}`);
    }
  } else {
    const blob = new Blob([data], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------------
// SVG Export (for heatmap and bubbles)
// ---------------------------------------------------------------------------

/**
 * Clone an SVG element with all computed styles inlined for standalone export.
 */
function cloneSvgWithStyles(svgEl: SVGSVGElement): SVGSVGElement {
  const clone = svgEl.cloneNode(true) as SVGSVGElement;

  // Inline computed styles on every element
  const origElements = svgEl.querySelectorAll('*');
  const cloneElements = clone.querySelectorAll('*');

  for (let i = 0; i < origElements.length; i++) {
    const computed = window.getComputedStyle(origElements[i]);
    const el = cloneElements[i] as SVGElement | HTMLElement;
    // Key styles for publication figures
    const props = [
      'fill', 'stroke', 'stroke-width', 'opacity', 'font-family', 'font-size',
      'font-weight', 'text-anchor', 'dominant-baseline', 'color', 'letter-spacing'
    ];
    for (const prop of props) {
      const val = computed.getPropertyValue(prop);
      if (val) {
        el.style.setProperty(prop, val);
      }
    }
  }

  // Set white background for publication
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', '100%');
  bg.setAttribute('height', '100%');
  bg.setAttribute('fill', 'white');
  clone.insertBefore(bg, clone.firstChild);

  // Ensure viewBox and dimensions are set
  if (!clone.getAttribute('xmlns')) {
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }

  return clone;
}

/**
 * Export an SVG element as a PNG file at a given scale factor.
 */
export async function exportSvgAsPng(
  svgEl: SVGSVGElement,
  defaultFilename: string,
  scale: number = 3
): Promise<void> {
  const clone = cloneSvgWithStyles(svgEl);
  const svgData = new XMLSerializer().serializeToString(clone);
  const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  const width = svgEl.viewBox?.baseVal?.width || svgEl.clientWidth || 800;
  const height = svgEl.viewBox?.baseVal?.height || svgEl.clientHeight || 600;

  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve();
    };
    img.onerror = reject;
    img.src = url;
  });

  URL.revokeObjectURL(url);

  const pngBlob = await new Promise<Blob>((resolve) => {
    canvas.toBlob((blob) => resolve(blob!), 'image/png');
  });
  const buffer = new Uint8Array(await pngBlob.arrayBuffer());
  await saveBinary(buffer, defaultFilename, 'PNG Images', ['png'], 'image/png');
}

// ---------------------------------------------------------------------------
// HTML Element Export (for isotype table)
// ---------------------------------------------------------------------------

/**
 * Export an HTML element (e.g., a table) as a PNG using html2canvas.
 */
export async function exportHtmlAsPng(
  element: HTMLElement,
  defaultFilename: string,
  scale: number = 3
): Promise<void> {
  const canvas = await html2canvas(element, {
    scale,
    backgroundColor: '#ffffff',
    logging: false,
    useCORS: true
  });

  const pngBlob = await new Promise<Blob>((resolve) => {
    canvas.toBlob((blob) => resolve(blob!), 'image/png');
  });
  const buffer = new Uint8Array(await pngBlob.arrayBuffer());
  await saveBinary(buffer, defaultFilename, 'PNG Images', ['png'], 'image/png');
}
