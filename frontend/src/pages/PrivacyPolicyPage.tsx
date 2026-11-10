import { useTranslation } from "react-i18next";
import LanguageSwitcher from "../i18n/LanguageSwitcher";

export default function PrivacyPolicyPage() {
  const { t } = useTranslation();

  const informationItems = t("privacy.sections.information.items", {
    returnObjects: true,
  }) as string[];

  const usageItems = t("privacy.sections.usage.items", {
    returnObjects: true,
  }) as string[];

  const rightsItems = t("privacy.sections.rights.items", {
    returnObjects: true,
  }) as string[];

  return (
    <div className="min-h-screen bg-bgPrimary text-textPrimary">
      <div className="mx-auto max-w-5xl p-8">

        <div className="flex justify-end mt-4">
          <LanguageSwitcher />
        </div>
        
        <h1 className="mt-6 text-4xl font-bold">
          {t("privacy.title")}
        </h1>

        <p className="mt-2 text-sm text-gray-400">
          {t("privacy.lastUpdated")}
        </p>

        <div className="mt-10 space-y-10">

          <section>
            <h2 className="text-2xl font-semibold mb-3">
              {t("privacy.sections.introduction.title")}
            </h2>

            <p className="text-gray-300 leading-8">
              {t("privacy.sections.introduction.text")}
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-3">
              {t("privacy.sections.information.title")}
            </h2>

            <p className="text-gray-300 leading-8 mb-4">
              {t("privacy.sections.information.text")}
            </p>

            <ul className="list-disc pl-8 space-y-2 text-gray-300">
              {informationItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-3">
              {t("privacy.sections.usage.title")}
            </h2>

            <p className="text-gray-300 leading-8 mb-4">
              {t("privacy.sections.usage.text")}
            </p>

            <ul className="list-disc pl-8 space-y-2 text-gray-300">
              {usageItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-3">
              {t("privacy.sections.security.title")}
            </h2>

            <p className="text-gray-300 leading-8">
              {t("privacy.sections.security.text")}
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-3">
              {t("privacy.sections.sharing.title")}
            </h2>

            <p className="text-gray-300 leading-8">
              {t("privacy.sections.sharing.text")}
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-3">
              {t("privacy.sections.cookies.title")}
            </h2>

            <p className="text-gray-300 leading-8">
              {t("privacy.sections.cookies.text")}
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-3">
              {t("privacy.sections.rights.title")}
            </h2>

            <p className="text-gray-300 leading-8 mb-4">
              {t("privacy.sections.rights.text")}
            </p>

            <ul className="list-disc pl-8 space-y-2 text-gray-300">
              {rightsItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-3">
              {t("privacy.sections.retention.title")}
            </h2>

            <p className="text-gray-300 leading-8">
              {t("privacy.sections.retention.text")}
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-3">
              {t("privacy.sections.changes.title")}
            </h2>

            <p className="text-gray-300 leading-8">
              {t("privacy.sections.changes.text")}
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-3">
              {t("privacy.sections.contact.title")}
            </h2>

            <p className="text-gray-300 leading-8">
              {t("privacy.sections.contact.text")}
            </p>
          </section>

        </div>
      </div>
    </div>
  );
}