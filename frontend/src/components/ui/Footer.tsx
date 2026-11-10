import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

export default function Footer() {
  const { t } = useTranslation();
  return (
    <footer className="mt-10 border-t border-white/10 pt-6 text-center text-sm text-gray-400">
      <p className="mb-3">
        © {new Date().getFullYear()} {t("footer.copyright")}
      </p>

      <div className="flex justify-center gap-6">
        <Link
          to="/privacy"
          className="hover:text-pink-400 transition-colors"
        >
          {t("footer.privacy")}
        </Link>

        <Link
          to="/terms"
          className="hover:text-pink-400 transition-colors"
        >
          {t("footer.terms")}
        </Link>
      </div>
    </footer>
  );
}