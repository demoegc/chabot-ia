/**
 * Calcula la diferencia entre una fecha pasada y la fecha actual,
 * retornando el resultado en días, semanas o meses.
 *
 * @param {string} dateString La fecha pasada en formato ISO 8601 (ej: "2025-06-17T11:21:02+03:00").
 * @returns {{unidad: string, cantidad: number, mensaje?: string}} Objeto con la unidad ('días', 'semanas' o 'meses') y la cantidad.
 */
function calcularTiempoTranscurrido(dateString) {
    const fechaPasada = new Date(dateString);
    const fechaActual = new Date();

    // 1. Obtener la diferencia en milisegundos
    const diffMiliSegundos = fechaActual.getTime() - fechaPasada.getTime();

    // Si la fecha pasada es futura, indicamos un error
    if (diffMiliSegundos < 0) {
        return { unidad: 'error', cantidad: 0, mensaje: 'La fecha proporcionada es futura.' };
    }

    // Constantes de conversión
    const MS_POR_DIA = 1000 * 60 * 60 * 24;
    const UMBRAL_SEMANAS_DIAS = 7;     // Umbral para cambiar de días a semanas
    const UMBRAL_MESES_DIAS = 45;      // Umbral para cambiar de semanas a meses

    // 2. Calcular la diferencia en días
    const diffDias = Math.floor(diffMiliSegundos / MS_POR_DIA);

    // 3. Determinar la unidad: Días, Semanas o Meses
    if (diffDias < UMBRAL_SEMANAS_DIAS) {
        // Opción A: Menos de una semana -> Retornar en DÍAS
        return {
            unidad: 'días',
            cantidad: diffDias
        };

    } else if (diffDias < UMBRAL_MESES_DIAS) {
        // Opción B: Entre 7 y 44 días -> Retornar en SEMANAS
        const diffSemanas = Math.round(diffDias / 7);
        return {
            unidad: 'semanas',
            cantidad: diffSemanas
        };

    } else {
        // Opción C: 45 días o más -> Retornar en MESES

        // Cálculo de meses (más preciso que solo dividir por 30.4375)
        let meses = (fechaActual.getFullYear() - fechaPasada.getFullYear()) * 12;
        meses -= fechaPasada.getMonth();
        meses += fechaActual.getMonth();

        // Ajuste fino: si el día de la fecha actual es anterior al día de la fecha pasada,
        // significa que el mes no está completo, por lo que restamos uno.
        if (fechaActual.getDate() < fechaPasada.getDate()) {
            meses--;
        }

        const diffMeses = Math.max(0, meses); // Aseguramos que no sea negativo
        
        return {
            unidad: 'meses',
            cantidad: diffMeses
        };
    }
}

module.exports = calcularTiempoTranscurrido
