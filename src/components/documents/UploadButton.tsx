// The file picker behind every "attach a file" affordance (CONTRACT_TO_PROJECT_PLAN §5a).
//
// It exists as its own component for one reason: drag-and-drop cannot be the only way in. There is
// no drag on a phone, and this app is an installable PWA that has already regressed once by
// assuming a pointer (MOBILE_PWA.md — touch reordering). So the strip offers both, and this is the
// half that always works.
//
// A real <button> driving a hidden <input type="file">, rather than a <label> styled as one: a
// label is not in the tab order and cannot be pressed with the keyboard, and an attach control
// nobody can reach from the keyboard is a control half the users do not have.

import { useRef } from 'react';

export function UploadButton({
  onFiles,
  disabled = false,
  label = 'Choose a file',
  className = 'btn ghost tiny',
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  const input = useRef<HTMLInputElement | null>(null);

  return (
    <>
      {/* No `accept` filter: the server decides what it will store, and a guess here would grey
          out files it would happily take — silently, with nothing to explain it. A rejected
          upload comes back as a message the strip shows in place instead. */}
      <input
        ref={input}
        type="file"
        multiple
        className="doc-file-input"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          // Clear the input BEFORE handing the files on, so picking the same file again still
          // fires a change event. Without this, a failed upload cannot be retried from the picker.
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
      <button
        type="button"
        className={className}
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        {label}
      </button>
    </>
  );
}
