// input:  DOM drop target and file callback
// output: File-drag state and drop-to-callback wiring
// pos:    Desktop chat file-drop target hook
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
import {
  useEffect, useRef, useState,
  type Dispatch, type MutableRefObject, type RefObject, type SetStateAction,
} from 'react';

export interface FileDropState {
  active: boolean;
  fileCount: number;
}

function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

function fileCountOf(event: DragEvent): number {
  return event.dataTransfer?.items.length || event.dataTransfer?.files.length || 0;
}

function claimFileDrag(event: DragEvent): boolean {
  if (!carriesFiles(event)) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

interface FileDropHandlers {
  dragenter: (event: DragEvent) => void;
  dragleave: (event: DragEvent) => void;
  dragover: (event: DragEvent) => void;
  drop: (event: DragEvent) => void;
}

type StateSetter = Dispatch<SetStateAction<FileDropState>>;

function createHandlers(onFiles: MutableRefObject<(files: FileList) => void>,
  depth: MutableRefObject<number>, setState: StateSetter): FileDropHandlers {
  return {
    dragenter: (event) => {
      if (!claimFileDrag(event)) return;
      depth.current += 1;
      setState({ active: true, fileCount: fileCountOf(event) });
    },
    dragleave: (event) => {
      if (!claimFileDrag(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setState({ active: false, fileCount: 0 });
    },
    dragover: (event) => {
      if (!claimFileDrag(event)) return;
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      const fileCount = fileCountOf(event);
      if (fileCount > 0) setState({ active: true, fileCount });
    },
    drop: (event) => {
      if (!claimFileDrag(event)) return;
      depth.current = 0;
      setState({ active: false, fileCount: 0 });
      if (event.dataTransfer?.files.length) onFiles.current(event.dataTransfer.files);
    },
  };
}

function bindHandlers(target: HTMLElement, handlers: FileDropHandlers): () => void {
  const names = Object.keys(handlers) as (keyof FileDropHandlers)[];
  for (const name of names) target.addEventListener(name, handlers[name]);
  return () => {
    for (const name of names) target.removeEventListener(name, handlers[name]);
  };
}

export function useFileDropTarget(
  targetRef: RefObject<HTMLElement>,
  onFiles: (files: FileList) => void,
): FileDropState {
  const onFilesRef = useRef(onFiles);
  const dragDepth = useRef(0);
  const [state, setState] = useState<FileDropState>({ active: false, fileCount: 0 });
  onFilesRef.current = onFiles;

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    return bindHandlers(target, createHandlers(onFilesRef, dragDepth, setState));
  }, [targetRef]);

  return state;
}
