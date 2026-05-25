import { useEffect, useRef, useState } from "react";

import { JOB_BOARD_OPTIONS } from "../../../lib/board-options";

function summaryLabel(selectedIds: Set<string>) {
  if (selectedIds.size === 0) {
    return "Select job boards";
  }

  const labels = JOB_BOARD_OPTIONS.filter((o) => selectedIds.has(o.id)).map((o) => o.label);

  if (labels.length <= 2) {
    return labels.join(", ");
  }

  return `${labels.length} boards selected`;
}

export function BoardMultiSelect(props: {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  id?: string;
}) {
  const { selectedIds, onChange, id } = props;
  const selected = new Set(selectedIds);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    function onPointerDown(ev: MouseEvent) {
      if (!rootRef.current?.contains(ev.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function toggle(boardId: string) {
    const next = new Set(selected);

    if (next.has(boardId)) {
      next.delete(boardId);
    } else {
      next.add(boardId);
    }

    onChange(JOB_BOARD_OPTIONS.map((o) => o.id).filter((bid) => next.has(bid)));
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        id={id}
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((v) => !v)}
        className="mt-1 flex w-full items-center justify-between rounded-lg border border-gray-300 bg-white px-3 py-2 text-left text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
      >
        <span className="truncate">{summaryLabel(selected)}</span>
        <span className="ml-2 shrink-0 text-gray-500 dark:text-gray-400" aria-hidden>
          ▾
        </span>
      </button>
      {open ? (
        <div
          role="listbox"
          aria-multiselectable
          className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-950"
        >
          {JOB_BOARD_OPTIONS.map((option) => (
            <label
              key={option.id}
              role="option"
              aria-selected={selected.has(option.id)}
              className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-gray-900 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-900"
            >
              <input
                type="checkbox"
                className="rounded border-gray-300 dark:border-gray-600"
                checked={selected.has(option.id)}
                onChange={() => toggle(option.id)}
              />
              {option.label}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
