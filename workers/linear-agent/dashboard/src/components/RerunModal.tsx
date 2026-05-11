import { useState } from "react";
import { rerunSession } from "../lib/api";

export function RerunModal({
  sessionId,
  defaultPrompt,
  onClose,
  onRerunCreated,
}: {
  sessionId: string;
  defaultPrompt: string;
  onClose: () => void;
  onRerunCreated: () => void;
}) {
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await rerunSession(sessionId, prompt || undefined);
      onRerunCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rerun session");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div style={backdropStyle} onClick={onClose} />
      <div style={modalStyle}>
        <h3 style={{ margin: "0 0 1rem" }}>Rerun Session</h3>

        <label
          style={{
            display: "block",
            marginBottom: "0.5rem",
            fontSize: "0.875rem",
            fontWeight: 500,
          }}
        >
          Prompt
        </label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={8}
          style={{
            width: "100%",
            padding: "0.5rem",
            border: "1px solid #d1d5db",
            borderRadius: "0.375rem",
            fontFamily: "monospace",
            fontSize: "0.875rem",
            resize: "vertical",
            boxSizing: "border-box",
          }}
        />

        {error && (
          <p style={{ color: "#dc2626", fontSize: "0.875rem", marginTop: "0.5rem" }}>
            {error}
          </p>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "0.5rem",
            marginTop: "1rem",
          }}
        >
          <button onClick={onClose} style={cancelBtnStyle} disabled={submitting}>
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            style={confirmBtnStyle}
            disabled={submitting}
          >
            {submitting ? "Running..." : "Confirm Rerun"}
          </button>
        </div>
      </div>
    </>
  );
}

const backdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  backgroundColor: "rgba(0,0,0,0.4)",
  zIndex: 60,
};

const modalStyle: React.CSSProperties = {
  position: "fixed",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  backgroundColor: "white",
  padding: "1.5rem",
  borderRadius: "0.5rem",
  boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
  width: "min(32rem, 90vw)",
  zIndex: 70,
};

const cancelBtnStyle: React.CSSProperties = {
  padding: "0.375rem 0.75rem",
  border: "1px solid #d1d5db",
  borderRadius: "0.375rem",
  background: "white",
  cursor: "pointer",
  fontSize: "0.875rem",
};

const confirmBtnStyle: React.CSSProperties = {
  padding: "0.375rem 0.75rem",
  backgroundColor: "#2563eb",
  color: "white",
  border: "none",
  borderRadius: "0.375rem",
  cursor: "pointer",
  fontSize: "0.875rem",
};
