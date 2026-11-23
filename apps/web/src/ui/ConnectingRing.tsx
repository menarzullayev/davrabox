import { Davra } from '../brand/Davra';

export interface ConnectingRingProps {
  /** Visible and announced status text, e.g. "Connecting to the meeting". */
  label: string;
  size?: number;
}

/** The connecting animation: the davra ornament turning calmly with a status line (role="status"). */
export function ConnectingRing({ label, size = 144 }: ConnectingRingProps) {
  return (
    <div className="dx-connecting" role="status">
      <Davra size={size} rings={3} petals={10} animated />
      <span>{label}</span>
    </div>
  );
}
