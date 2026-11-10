import { useState } from "react";
import { useNavigate } from "react-router-dom";
import AuthLayout from "../layouts/AuthLayout";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import { register } from "../api/api";
import { useTranslation } from "react-i18next";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function RegisterPage() {
	const navigate = useNavigate();
	const { t } = useTranslation();

	const [username, setUsername] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");

	const handleRegister = async () => {
		const cleanUsername = username.trim();
		const cleanEmail = email.trim().toLowerCase();

		if (!cleanUsername || !cleanEmail || !password) {
			alert(t("validation.requiredFields"));
			return;
		}

		if (cleanUsername.length < 3 || cleanUsername.length > 20) {
			alert(t("validation.usernameLength"));
			return;
		}

		if (!EMAIL_REGEX.test(cleanEmail)) {
			alert(t("validation.invalidEmail"));
			return;
		}

		if (password.length < 8) {
			alert(t("validation.passwordLength"));
			return;
		}

		try {
			const data = await register(cleanUsername, cleanEmail, password);

			if (!data.success) {
				alert(data.error);
				return;
			}

			navigate("/");
		}
		catch {
			alert(t("errors.connection"));
		}
	};

	return (
		<AuthLayout>
			<div className="relative">
				<div className="flex flex-col gap-7">

					<div className="text-center">
						<h1 className="text-5xl font-bold text-pink-Primary">
							{t("register.title")}
						</h1>
					</div>

					<div className="flex flex-col gap-4">

						<Input
							placeholder={t("register.username")}
							value={username}
							onChange={(e) => setUsername(e.target.value)}
						/>

						<Input
							type="email"
							placeholder={t("login.email")}
							value={email}
							onChange={(e) => setEmail(e.target.value)}
						/>

						<Input
							type="password"
							placeholder={t("login.password")}
							value={password}
							onChange={(e) => setPassword(e.target.value)}
						/>

						<Button onClick={handleRegister}>
							{t("register.signUp")}
						</Button>

						<p className="text-center text-base">
							{t("register.haveAccount")}{" "}
							<span
								onClick={() => navigate("/")}
								className="cursor-pointer text-pink-Primary"
							>
								{t("register.signIn")}
							</span>
						</p>
					</div>

				</div>
			</div>
		</AuthLayout>
	);
}

export default RegisterPage;