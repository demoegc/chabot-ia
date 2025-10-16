const axios = require('axios');

// Configuración
const WEBHOOK_URL = 'https://tuagentedeinmigracion.bitrix24.co/rest/8659/vdy3s0ijju2t1e59';
const TARGET_STAGE = 'UC_EMY4OP';
const BATCH_SIZE = 50;
const DELAY_BETWEEN_REQUESTS = 500; // ms
const TERMINATION_DELAY = 800; // 800ms entre terminaciones de workflows

/**
 * Ejecuta una llamada a la API de Bitrix24
 */
async function callBitrixAPI(method, params = {}) {
    const url = `${WEBHOOK_URL}/${method}`;

    try {
        const response = await axios.post(url, params, {
            timeout: 30000,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        if (response.data.error) {
            throw new Error(`Bitrix24 API Error: ${response.data.error_description || response.data.error}`);
        }

        return response.data;

    } catch (error) {
        if (error.response) {
            throw new Error(`HTTP ${error.response.status}: ${error.response.data}`);
        }
        throw new Error(`API Call Failed: ${error.message}`);
    }
}

/**
 * Espera un tiempo determinado
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Obtiene todos los workflows activos con paginación
 */
async function getAllActiveWorkflows() {
    let allWorkflows = [];
    let start = 0;
    let hasMore = true;

    console.log('Obteniendo workflows activos...');

    while (hasMore) {
        try {
            const result = await callBitrixAPI('bizproc.workflow.instances', {
                SELECT: ['TEMPLATE_ID', 'ID', 'DOCUMENT_ID'],
                start: start
            });

            if (result.result && Array.isArray(result.result)) {
                const workflows = result.result;
                allWorkflows = [...allWorkflows, ...workflows];

                console.log(`Obtenidos ${workflows.length} workflows desde posición ${start}`);

                // Si obtenemos menos del batchSize, es la última página
                if (workflows.length < BATCH_SIZE) {
                    hasMore = false;
                } else {
                    start += BATCH_SIZE;
                }
            } else {
                hasMore = false;
            }

            // Pequeña pausa para no sobrecargar la API
            await sleep(DELAY_BETWEEN_REQUESTS);

        } catch (error) {
            console.error('Error obteniendo workflows:', error.message);
            hasMore = false;
        }
    }

    console.log(`Total de workflows obtenidos: ${allWorkflows.length}`);
    return allWorkflows;
}

/**
 * Obtiene la información de un lead
 */
async function getLead(leadId) {
    // Extraer el ID numérico del lead (ej: "LEAD_4065" -> 4065)
    const numericId = leadId.replace('LEAD_', '');

    try {
        const result = await callBitrixAPI('crm.lead.get', {
            id: numericId
        });

        return result.result || null;
    } catch (error) {
        console.error(`Error obteniendo lead ${leadId}:`, error.message);
        return null;
    }
}

/**
 * Termina un workflow específico con delay de 800ms
 */
async function terminateWorkflow(workflowId) {
    try {
        const result = await callBitrixAPI('bizproc.workflow.terminate', {
            id: workflowId
        });

        return result.result === true;
    } catch (error) {
        console.error(`Error terminando workflow ${workflowId}:`, error.message);
        return false;
    }
}

/**
 * Procesa un workflow individual con delay de 800ms entre terminaciones
 */
async function processWorkflow(workflow, index, total, targetStage, lastTerminationTime) {
    const workflowId = workflow.ID;
    const documentId = workflow.DOCUMENT_ID;

    // Mostrar progreso
    if ((index + 1) % 10 === 0) {
        console.log(`Progreso: ${index + 1}/${total} workflows verificados`);
    }

    // Verificar que sea un lead
    if (documentId && documentId.startsWith('LEAD_')) {
        console.log(`\n[${index + 1}/${total}] Procesando workflow ${workflowId} para lead ${documentId}`);

        // Obtener información del lead
        const lead = await getLead(documentId);

        if (lead && lead.STATUS_ID) {
            const currentStage = lead.STATUS_ID;

            console.log(`   Lead ${documentId} está en etapa: ${currentStage}`);

            // Verificar si está en la etapa objetivo
            if (currentStage === targetStage) {
                console.log(`   ✓ Terminando workflow ${workflowId} (Lead en etapa ${targetStage})`);

                // Aplicar delay de 800ms si hubo una terminación previa
                const now = Date.now();
                if (lastTerminationTime && (now - lastTerminationTime) < TERMINATION_DELAY) {
                    const waitTime = TERMINATION_DELAY - (now - lastTerminationTime);
                    console.log(`   ⏳ Esperando ${waitTime}ms antes de terminar el siguiente workflow...`);
                    await sleep(waitTime);
                }

                // Terminar el workflow
                const success = await terminateWorkflow(workflowId);

                if (success) {
                    console.log(`   ✓ Workflow ${workflowId} terminado exitosamente`);
                    return {
                        terminated: true,
                        error: false,
                        terminationTime: Date.now()
                    };
                } else {
                    console.log(`   ✗ Error al terminar workflow ${workflowId}`);
                    return {
                        terminated: false,
                        error: true,
                        terminationTime: lastTerminationTime
                    };
                }
            } else {
                console.log(`   ○ Workflow ${workflowId} no requiere terminación (etapa diferente)`);
                return {
                    terminated: false,
                    error: false,
                    terminationTime: lastTerminationTime
                };
            }
        } else {
            console.log(`   ✗ No se pudo obtener información del lead ${documentId}`);
            return {
                terminated: false,
                error: true,
                terminationTime: lastTerminationTime
            };
        }
    } else {
        console.log(`   ○ Workflow ${workflowId} no es para un lead (documento: ${documentId})`);
        return {
            terminated: false,
            error: false,
            terminationTime: lastTerminationTime
        };
    }
}

/**
 * Procesa todos los workflows y termina los que están en la etapa específica con intervalos de 800ms
 */
async function terminateWorkflowsInStage(targetStage) {
    let terminatedCount = 0;
    let checkedCount = 0;
    let errorCount = 0;
    let lastTerminationTime = null;

    try {
        const workflows = await getAllActiveWorkflows();

        if (workflows.length === 0) {
            console.log('No se encontraron workflows activos.');
            return { terminatedCount, checkedCount, errorCount };
        }

        console.log(`\nProcesando ${workflows.length} workflows...`);
        console.log(`Intervalo entre terminaciones: ${TERMINATION_DELAY}ms`);

        // Procesar cada workflow secuencialmente
        for (let i = 0; i < workflows.length; i++) {
            const result = await processWorkflow(
                workflows[i],
                i,
                workflows.length,
                targetStage,
                lastTerminationTime
            );

            checkedCount++;
            if (result.terminated) {
                terminatedCount++;
                lastTerminationTime = result.terminationTime;
            }
            if (result.error) errorCount++;

            // Pequeña pausa entre procesamientos (solo si no es una terminación)
            // if (!result.terminated) {
            //     await sleep(1000);
            // }
            await sleep(800);
        }

        // Mostrar resumen
        console.log('\n' + '='.repeat(50));
        console.log('RESUMEN EJECUCIÓN');
        console.log('='.repeat(50));
        console.log(`Workflows verificados: ${checkedCount}`);
        console.log(`Workflows terminados: ${terminatedCount}`);
        console.log(`Errores encontrados: ${errorCount}`);
        console.log(`Etapa objetivo: ${targetStage}`);
        console.log(`Intervalo de terminación: ${TERMINATION_DELAY}ms`);
        console.log('='.repeat(50));

    } catch (error) {
        console.error('ERROR en el proceso principal:', error.message);
        return { terminatedCount, checkedCount, errorCount: errorCount + 1 };
    }

    return { terminatedCount, checkedCount, errorCount };
}

/**
 * Función principal
 */
async function main() {
    console.log('='.repeat(60));
    console.log('INICIANDO PROCESO DE TERMINACIÓN DE WORKFLOWS');
    console.log('='.repeat(60));
    console.log(`Etapa objetivo: ${TARGET_STAGE}`);
    console.log(`Webhook: ${WEBHOOK_URL}`);
    console.log(`Intervalo entre terminaciones: ${TERMINATION_DELAY}ms`);
    console.log('='.repeat(60) + '\n');

    const startTime = Date.now();
    const result = await terminateWorkflowsInStage(TARGET_STAGE);
    const endTime = Date.now();
    const executionTime = ((endTime - startTime) / 1000).toFixed(2);

    console.log(`\nTiempo de ejecución: ${executionTime} segundos`);

    if (result.errorCount === 0) {
        console.log('🎉 Proceso completado exitosamente');
    } else {
        console.log('⚠️ Proceso completado con algunos errores');
    }
}

// Manejo de errores global
process.on('unhandledRejection', (error) => {
    console.error('Error no manejado:', error);
    process.exit(1);
});

process.on('uncaughtException', (error) => {
    console.error('Excepción no capturada:', error);
    process.exit(1);
});

// Ejecutar el script si es llamado directamente
if (require.main === module) {
    main().catch(error => {
        console.error('❌ Error fatal:', error);
        process.exit(1);
    });
}

// Exportar funciones para uso externo si es necesario
module.exports = {
    callBitrixAPI,
    getAllActiveWorkflows,
    getLead,
    terminateWorkflow,
    terminateWorkflowsInStage
};