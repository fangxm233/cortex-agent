// input:  nothing (leaf constant module)
// output: IMAGE_MIMES / VIDEO_MIMES
// pos:    Attachment mimetype classification shared by prompt building and file routing
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

/** Mimetypes a backend can read as an image attachment. Both the prompt builder (which decides how
 *  an attachment is described to the agent) and the platform file router classify against the same
 *  two sets, so they live below both rather than in either one. */
export const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const VIDEO_MIMES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska']);
