const ACCEPT = ".json,.geojson,.gpx,.kml,.fit";
const MAX_SIZE = 50 * 1024 * 1024; // 50 MB

/**
 * Open a file picker and return the selected file's name and content.
 * Binary formats (.fit) are returned as ArrayBuffer; all others as string.
 * @returns {Promise<{name: string, content: string|ArrayBuffer}>}
 */
export function pickFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ACCEPT;
    input.style.display = "none";
    document.body.appendChild(input);

    input.addEventListener("change", () => {
      const file = input.files?.[0];
      document.body.removeChild(input);
      if (!file) return reject(new Error("No file selected."));
      if (file.size > MAX_SIZE) return reject(new Error("File too large. Maximum size is 50 MB."));

      const isBinary = file.name.toLowerCase().endsWith(".fit");
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, content: reader.result });
      reader.onerror = () => reject(new Error("Could not read the file."));
      if (isBinary) {
        reader.readAsArrayBuffer(file);
      } else {
        reader.readAsText(file);
      }
    });

    // Handle cancel (no file selected)
    input.addEventListener("cancel", () => {
      document.body.removeChild(input);
      reject(new Error("No file selected."));
    });

    input.click();
  });
}

/**
 * Save content as a file download.
 * Tries the Web Share API on mobile, falls back to a download link.
 * @param {string} fileName
 * @param {string|Blob} content
 * @param {string} mimeType
 */
export async function saveFile(fileName, content, mimeType) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const file = new File([blob], fileName, { type: mimeType });

  // Try Web Share API (works on mobile browsers and Capacitor WebView)
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch {
      // User cancelled or share failed — fall through to download
    }
  }

  // Fallback: trigger a download
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
