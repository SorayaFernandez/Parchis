import { useTranslation } from "react-i18next";
import LanguageSwitcher from "../i18n/LanguageSwitcher";

export default function TermsOfServicePage() {
  const { t } = useTranslation();

  return (
    <div className="min-h-screen bg-bgPrimary text-textPrimary">
      <div className="mx-auto max-w-5xl p-8">

        <div className="flex justify-end mt-4">
          <LanguageSwitcher />
        </div>

        <h1 className="mt-6 text-4xl font-bold">
          {t("terms.title")}
        </h1>

        <p className="mt-2 text-sm text-gray-400">
          {t("terms.lastUpdated")}
        </p>

        <div className="mt-10 space-y-10">

          <section>
            <h2 className="mb-3 text-2xl font-semibold">
              {t("terms.acceptance.title")}
            </h2>

            <p className="leading-8 text-gray-300">
              {t("terms.acceptance.text")}
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-2xl font-semibold">
              {t("terms.project.title")}
            </h2>

            <p className="leading-8 text-gray-300">
              {t("terms.project.text")}
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-2xl font-semibold">
              {t("terms.accounts.title")}
            </h2>

            <p className="leading-8 text-gray-300 mb-4">
              {t("terms.accounts.text")}
            </p>

            <ul className="list-disc pl-8 space-y-2 text-gray-300">
              <li>{t("terms.accounts.items.0")}</li>
              <li>{t("terms.accounts.items.1")}</li>
              <li>{t("terms.accounts.items.2")}</li>
              <li>{t("terms.accounts.items.3")}</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-2xl font-semibold">
              {t("terms.fairPlay.title")}
            </h2>

            <p className="leading-8 text-gray-300 mb-4">
              {t("terms.fairPlay.text")}
            </p>

            <ul className="list-disc pl-8 space-y-2 text-gray-300">
              <li>{t("terms.fairPlay.items.0")}</li>
              <li>{t("terms.fairPlay.items.1")}</li>
              <li>{t("terms.fairPlay.items.2")}</li>
              <li>{t("terms.fairPlay.items.3")}</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-2xl font-semibold">
              {t("terms.community.title")}
            </h2>

            <p className="leading-8 text-gray-300 mb-4">
              {t("terms.community.text")}
            </p>

            <ul className="list-disc pl-8 space-y-2 text-gray-300">
              <li>{t("terms.community.items.0")}</li>
              <li>{t("terms.community.items.1")}</li>
              <li>{t("terms.community.items.2")}</li>
              <li>{t("terms.community.items.3")}</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-2xl font-semibold">
              {t("terms.property.title")}
            </h2>

            <p className="leading-8 text-gray-300">
              {t("terms.property.text")}
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-2xl font-semibold">
              {t("terms.availability.title")}
            </h2>

            <p className="leading-8 text-gray-300">
              {t("terms.availability.text")}
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-2xl font-semibold">
              {t("terms.liability.title")}
            </h2>

            <p className="leading-8 text-gray-300">
              {t("terms.liability.text")}
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-2xl font-semibold">
              {t("terms.termination.title")}
            </h2>

            <p className="leading-8 text-gray-300">
              {t("terms.termination.text")}
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-2xl font-semibold">
              {t("terms.changes.title")}
            </h2>

            <p className="leading-8 text-gray-300">
              {t("terms.changes.text")}
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-2xl font-semibold">
              {t("terms.contact.title")}
            </h2>

            <p className="leading-8 text-gray-300">
              {t("terms.contact.text")}
            </p>
          </section>

        </div>
      </div>
    </div>
  );
}