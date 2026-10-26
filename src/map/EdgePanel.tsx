/** A selected link: where it was found, how sure we are, and keep / remove. */
import { ArrowRight, Check, Trash2, X } from "lucide-react";
import { Button, cx, IconButton } from "../components/ui";
import type { GraphEdge } from "./GraphCanvas";
import type { Confidence, MapEdge, SourceKind } from "./model";

export const SOURCE_SHORT: Record<SourceKind, string> = {
  compose: "compose",
  env: "env",
  config: "config",
  k8s: "k8s",
  code: "code",
  traffic: "seen",
  connection: "conn",
  manual: "manual",
};

export const SOURCE_LABEL: Record<SourceKind, string> = {
  compose: "Docker Compose",
  env: ".env file",
  config: "Config file",
  k8s: "Kubernetes manifest",
  code: "Source code",
  traffic: "Seen in a trace",
  connection: "Seen as an open connection",
  manual: "Added or kept by you",
};

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  manual: "Added or kept by you",
  declared: "Declared in config",
  observed: "Seen at runtime",
  inferred: "Inferred from files",
};

/** The canvas form of a map link; `name` turns node keys into what the canvas shows. */
export function toGraphEdge(e: MapEdge, id: (key: string) => string): GraphEdge {
  const strongest = e.evidence.find((x) => x.confidence === e.confidence) ?? e.evidence[0];
  return {
    from: id(e.from),
    to: id(e.to),
    label: SOURCE_SHORT[strongest?.source ?? "manual"],
    tentative: e.confidence === "inferred",
    title: `${CONFIDENCE_LABEL[e.confidence]} · ${e.evidence.length} source${e.evidence.length === 1 ? "" : "s"}`,
  };
}

export function EdgePanel({ edge, fromLabel, toLabel, onKeep, onRemove, onClose }: { edge: MapEdge; fromLabel: string; toLabel: string; onKeep: () => void; onRemove: () => void; onClose: () => void }) {
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="font-semibold">{fromLabel}</span>
        <ArrowRight className="size-3.5 text-fg-3" />
        <span className="font-semibold">{toLabel}</span>
        <span className={cx("rounded px-1.5 text-xs text-fg-2", edge.confidence === "inferred" ? "border border-dashed border-line-strong" : "bg-surface-3")}>{CONFIDENCE_LABEL[edge.confidence]}</span>
        <span className="flex-1" />
        <IconButton size="sm" label="Close" onClick={onClose}>
          <X />
        </IconButton>
      </div>
      <ul className="mt-2 grid max-h-36 gap-1.5 overflow-auto">
        {edge.evidence.map((ev, i) => (
          <li key={i} className="grid gap-0.5">
            <span className="text-xs text-fg-2">
              {SOURCE_LABEL[ev.source]}
              {ev.lastSeen && <span className="text-fg-3"> · last seen {new Date(ev.lastSeen).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>}
            </span>
            {ev.source !== "manual" && <span className="rounded bg-rail px-2 py-1 font-mono text-xs break-all whitespace-pre-wrap text-fg-3 select-text">{ev.detail}</span>}
          </li>
        ))}
      </ul>
      <div className="mt-2.5 flex items-center gap-2">
        {edge.confidence !== "manual" && (
          <Button size="sm" variant="primary" onClick={onKeep} title="Keep this link even if the files stop mentioning it">
            <Check /> Keep link
          </Button>
        )}
        <Button
          size="sm"
          variant="danger"
          onClick={() => {
            onRemove();
            onClose();
          }}
          title="Hide this link; scanning again won't bring it back"
        >
          <Trash2 /> Remove
        </Button>
      </div>
    </>
  );
}
