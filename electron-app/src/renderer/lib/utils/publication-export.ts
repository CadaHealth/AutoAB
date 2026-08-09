/**
 * Publication-ready figure export.
 * Clones an SVG element, inlines all computed styles, and exports as SVG or high-DPI PNG.
 */

// ---------------------------------------------------------------------------
// SVG export
// ---------------------------------------------------------------------------

/**
 * Inline all computed styles on an element and its children.
 * This resolves CSS variables (var(--x)) and ensures the SVG is self-contained.
 */
function inlineComputedStyles(source: SVGElement, clone: SVGElement): void {
  const sourceChildren = source.children;
  const cloneChildren = clone.children;

  // Inline styles on the element itself
  if (source instanceof SVGElement && clone instanceof SVGElement) {
    const computed = window.getComputedStyle(source);
    // Only inline style properties that are relevant for SVG rendering
    const svgProps = [
      'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray',
      'stroke-linecap', 'stroke-linejoin', 'stroke-opacity',
      'font-family', 'font-size', 'font-weight', 'font-style',
      'text-anchor', 'dominant-baseline', 'opacity', 'cursor'
    ];
    for (const prop of svgProps) {
      const val = computed.getPropertyValue(prop);
      if (val && val !== 'none' && val !== 'normal' && val !== '' && !val.includes('var(')) {
        (clone as any).style[prop] = val;
      }
    }
  }

  // Recurse into children
  for (let i = 0; i < sourceChildren.length && i < cloneChildren.length; i++) {
    if (sourceChildren[i] instanceof SVGElement && cloneChildren[i] instanceof SVGElement) {
      inlineComputedStyles(sourceChildren[i] as SVGElement, cloneChildren[i] as SVGElement);
    }
  }
}

/**
 * Clone an SVG element from the DOM, inline all styles, and return
 * a standalone SVG string ready for download or PNG conversion.
 */
export function cloneSvgForPublication(svgElement: SVGSVGElement): string {
  const clone = svgElement.cloneNode(true) as SVGSVGElement;

  // Inline computed styles so CSS variables are resolved
  inlineComputedStyles(svgElement, clone);

  // Set white background and ensure proper namespace
  clone.setAttribute('style', 'background: #fff;');
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

  // Ensure all text uses proper font (catch any remaining var() references)
  clone.querySelectorAll('text').forEach(el => {
    if (!el.style.fontFamily || el.style.fontFamily.includes('var(')) {
      el.style.fontFamily = 'Arial, Helvetica, sans-serif';
    }
    if (!el.style.fill || el.style.fill.includes('var(')) {
      el.style.fill = '#333';
    }
  });

  // Remove any UI-specific elements
  clone.querySelectorAll('[data-ui-only]').forEach(el => el.remove());

  // Serialize
  const serializer = new XMLSerializer();
  let svgString = serializer.serializeToString(clone);

  // Strip any remaining CSS variable references that could break rendering
  svgString = svgString.replace(/var\(--[^)]+\)/g, '#666');

  // Add XML declaration
  svgString = '<?xml version="1.0" encoding="UTF-8"?>\n' + svgString;

  return svgString;
}

/**
 * Export an SVG element as a downloadable SVG file.
 */
export function downloadSvg(svgElement: SVGSVGElement, filename: string): void {
  const svgString = cloneSvgForPublication(svgElement);
  const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  triggerDownload(blob, filename.endsWith('.svg') ? filename : `${filename}.svg`);
}

/**
 * Export an SVG element as a high-DPI PNG (default 300 DPI → 3x scale).
 */
export async function downloadPng(
  svgElement: SVGSVGElement,
  filename: string,
  scale: number = 3
): Promise<void> {
  // Read dimensions from attributes first (works even when display:none),
  // then fall back to baseVal, then to defaults
  const width = parseInt(svgElement.getAttribute('width') || '0') ||
    svgElement.width?.baseVal?.value || 800;
  const height = parseInt(svgElement.getAttribute('height') || '0') ||
    svgElement.height?.baseVal?.value || 600;

  if (width <= 0 || height <= 0) {
    throw new Error('Chart has no content to export. Please ensure data is loaded.');
  }

  const svgString = cloneSvgForPublication(svgElement);

  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d')!;

  // White background
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Convert SVG string to a data URL (avoids blob/cross-origin issues)
  const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString);

  const img = new Image();
  img.width = width;
  img.height = height;

  return new Promise((resolve, reject) => {
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      try {
        canvas.toBlob((pngBlob) => {
          if (pngBlob) {
            triggerDownload(pngBlob, filename.endsWith('.png') ? filename : `${filename}.png`);
            resolve();
          } else {
            // Fallback: try toDataURL instead
            try {
              const dataURL = canvas.toDataURL('image/png');
              const byteString = atob(dataURL.split(',')[1]);
              const ab = new ArrayBuffer(byteString.length);
              const ia = new Uint8Array(ab);
              for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
              const fallbackBlob = new Blob([ab], { type: 'image/png' });
              triggerDownload(fallbackBlob, filename.endsWith('.png') ? filename : `${filename}.png`);
              resolve();
            } catch (e) {
              reject(new Error('Failed to create PNG. Try exporting as SVG instead.'));
            }
          }
        }, 'image/png');
      } catch (e) {
        reject(new Error('PNG export not supported. Try exporting as SVG instead.'));
      }
    };
    img.onerror = () => {
      reject(new Error('Failed to render SVG for PNG export. Try SVG format instead.'));
    };
    img.src = dataUrl;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
