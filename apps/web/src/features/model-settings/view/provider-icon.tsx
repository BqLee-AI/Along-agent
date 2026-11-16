import Image from 'next/image';
import { Bot } from 'lucide-react';
import { providerPresets } from '../model/provider-presets';

export function ProviderIcon({ name, large = false }: { name: string; large?: boolean }) {
  const preset = providerPresets.find(
    (item) => item.name.toLowerCase() === name.trim().toLowerCase(),
  );
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-xl border border-black/5 bg-white ${large ? 'size-14' : 'size-9'}`}
    >
      {preset ? (
        <Image
          src={`/provider-icons/${preset.icon}.svg`}
          alt=""
          width={large ? 32 : 22}
          height={large ? 32 : 22}
        />
      ) : (
        <Bot className={large ? 'size-7 text-slate-500' : 'size-5 text-slate-500'} />
      )}
    </span>
  );
}
