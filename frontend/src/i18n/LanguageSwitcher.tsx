import { useTranslation } from "react-i18next";

export default function LanguageSwitcher() {
	const { i18n } = useTranslation();

	function changeLanguage(language: string) {
		i18n.changeLanguage(language);
		localStorage.setItem("language", language);
	}

	return (
		<select
			value={i18n.language}
			onChange={(e) => changeLanguage(e.target.value)}
			className="rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm"
		>
			<option value="es">🇪🇸 ES</option>
			<option value="en">🇬🇧 EN</option>
			<option value="fr">🇫🇷 FR</option>
		</select>
	);
}