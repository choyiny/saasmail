import SenderIdentitiesSettings from "@/components/SenderIdentitiesSettings";

export default function SettingsPage() {
  return (
    <div className="flex-1 overflow-auto p-6">
      <h1 className="text-lg font-semibold text-text-primary mb-6">Settings</h1>
      <SenderIdentitiesSettings />
    </div>
  );
}
