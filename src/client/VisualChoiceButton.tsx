interface VisualChoiceButtonProps {
  icon: string;
  title: string;
  detail?: string;
  className?: string;
  disabled?: boolean;
  onClick: () => void;
  ariaLabel?: string;
}

/** A large, icon-first choice for consequences that must read at a glance. */
export function VisualChoiceButton({
  icon,
  title,
  detail,
  className = '',
  disabled = false,
  onClick,
  ariaLabel,
}: VisualChoiceButtonProps) {
  return (
    <button
      className={`btn visual-choice ${className}`}
      disabled={disabled}
      onClick={onClick}
      aria-label={ariaLabel ?? title}
    >
      <span className="visual-choice__icon" aria-hidden="true">{icon}</span>
      <strong>{title}</strong>
      {detail && <span className="visual-choice__detail">{detail}</span>}
    </button>
  );
}
