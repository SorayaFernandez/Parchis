import { useEffect, useState } from "react";

export function useBoardSize() {
  const [size, setSize] = useState(900);

  useEffect(() => {
    const update = () => {
      const next =
        Math.min(window.innerWidth * 0.7, window.innerHeight * 0.9);

      setSize(next);
    };

    update();

    window.addEventListener("resize", update);

    return () => {
      window.removeEventListener("resize", update);
    };
  }, []);

  return size;
}