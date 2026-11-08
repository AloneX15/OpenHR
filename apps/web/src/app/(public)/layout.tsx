import { ThemeSwitch } from '@/components/ThemeSwitch';

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="public-theme">
        <ThemeSwitch compact />
      </div>
      {children}
    </>
  );
}
