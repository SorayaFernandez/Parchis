import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";

const savedLanguage = localStorage.getItem("language") || "es";

i18n
	.use(initReactI18next)
	.init({
		resources: {
			es: {
				translation: es,
			},
			en: {
				translation: en,
			},
			fr: {
				translation: fr,
			},
		},

		lng: savedLanguage,
		fallbackLng: "en",

		interpolation: {
			escapeValue: false,
		},
	});

export default i18n;